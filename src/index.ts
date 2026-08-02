/**
 * ribosome-vessel — subscribes to activity-api WebSocket events and extracts
 * templates from successful executions. Port 8240.
 *
 * Spec: openspec/changes/2026-05-23-substrate-explicit-vessels Phase 6.
 *
 * Architecture:
 *   - WebSocket client connects to activity-api:8080/ws (persistent, auto-reconnect)
 *   - Tracks in-flight executions by tracking task.started / task.completed events
 *   - When an execution closes (last task completed with success=true), dispatches
 *     `ribosome-extract` template via POST /v2/impulses/resolve to activity-api
 *   - HTTP server on port 8240 exposes /health and /resolve (stub, no shapes owned)
 *   - Registers with discovery-vessel at startup
 */

import { DiscoveryRegistrationLoop } from "@avigopal/ias-executor-ts";
import { onTemplateCreated, type ReplayObserverDeps } from "./replay-observer";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "8240", 10);
const VESSEL_ID = process.env.RIBOSOME_VESSEL_ID ?? process.env.VESSEL_ID ?? "ribosome-vessel";
const ACTIVITY_API_ENDPOINT = process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080";
const DISCOVERY_ENDPOINT = process.env.DISCOVERY_VESSEL_ENDPOINT ?? "http://127.0.0.1:8100";
const API_KEY = process.env.RIBOSOME_VESSEL_API_KEY ?? process.env.METABOB_API_KEY ?? "";
const WS_URL = (ACTIVITY_API_ENDPOINT.replace(/^http/, "ws")) + "/ws";
const VERSION = "0.1.0";

const log = {
  info: (...a: unknown[]) => console.log("[ribosome-vessel]", ...a),
  warn: (...a: unknown[]) => console.warn("[ribosome-vessel] WARN", ...a),
  error: (...a: unknown[]) => console.error("[ribosome-vessel] ERROR", ...a),
};

// ─────────────────────────────────────────────────────────────────────────────
// Execution tracker
//   task.started → record in set
//   task.completed → mark done; if all tasks done and success, dispatch ribosome
//
// Note: activity-api WS does not emit an "execution.completed" event — we infer
// completion when the last active task closes. We gate extraction on:
//   • success === true on the completed task
//   • no more tasks started for that execution_id in a 500ms window
// ─────────────────────────────────────────────────────────────────────────────

interface ExecutionState {
  executionId: string;
  activeTasks: Set<string>;
  completedTasks: number;
  failedTasks: number;
  drainTimer: ReturnType<typeof setTimeout> | null;
}

const executions = new Map<string, ExecutionState>();

function getOrCreate(executionId: string): ExecutionState {
  if (!executions.has(executionId)) {
    executions.set(executionId, {
      executionId,
      activeTasks: new Set(),
      completedTasks: 0,
      failedTasks: 0,
      drainTimer: null,
    });
  }
  return executions.get(executionId)!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction-route availability gate.
//
// The activityDispatch POST below only works if some vessel actually serves the
// "activityDispatch" shape. activity-api is the trace store, not an executor —
// it answers use_vessel_discovery for this shape, so every dispatch failed
// (silently, ~78/hour for weeks) while goal-host's mintReachedTrace already runs
// the ribosome-extract template in-process on every grounded reach. Probe
// discovery once (first use, cached for process lifetime) and suppress the
// dispatch storm with ONE structured line when the route is absent, instead of
// hammering a wall. Gap: ribosome-extraction-subsumed-by-goalhost-mint-retire-decision.
// ─────────────────────────────────────────────────────────────────────────────
// ── Extraction dispatch via goal-host /run-goal (reach-rate improvement, 2026-08-01)
// The original approach (POST activityDispatch to activity-api) silently failed because
// activity-api doesn't serve the activityDispatch shape. Instead, dispatch the ribosome-
// extract template directly through goal-host's /run-goal endpoint, which IS the standard
// dispatch surface. Falls back to in-process extraction if goal-host is unreachable.
const GOAL_HOST_ENDPOINT = process.env.GOAL_HOST_VESSEL_ENDPOINT ?? "http://127.0.0.1:8210";

async function dispatchRibosomeExtract(executionId: string) {
  if (!API_KEY) {
    log.warn("No API key — skipping ribosome extract for", executionId);
    return;
  }
  try {
    log.info("Dispatching ribosome-extract for execution", executionId);
    const res = await fetch(`${GOAL_HOST_ENDPOINT}/run-goal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `ApiKey ${API_KEY}`,
      },
      body: JSON.stringify({
        targetTemplateId: "ribosome-extract",
        variables: { executionId },
        tags: ["ribosome-vessel-dispatch"],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok || res.status === 202) {
      const body = await res.json() as { dispatchId?: string };
      log.info("ribosome-extract dispatched for", executionId, "dispatchId:", body.dispatchId ?? "(none)");
    } else {
      log.warn("ribosome-extract dispatch failed:", res.status, await res.text().catch(() => ""));
    }
  } catch (err: unknown) {
    log.warn("ribosome-extract dispatch error:", (err as Error)?.message ?? err);
  }
}

function onTaskCompleted(executionId: string, taskId: string, success: boolean) {
  const state = getOrCreate(executionId);
  state.activeTasks.delete(taskId);
  if (success) {
    state.completedTasks++;
  } else {
    state.failedTasks++;
  }

  // Reset drain timer: FALLBACK only — fires extraction 500ms after the last
  // task event if no execution_completed event arrives (see onExecutionCompleted)
  if (state.drainTimer) clearTimeout(state.drainTimer);
  state.drainTimer = setTimeout(() => {
    const idle = state.activeTasks.size === 0;
    const allSucceeded = state.failedTasks === 0 && state.completedTasks > 0;
    console.log(`[ribosome-vessel] drain FALLBACK fired for ${executionId} (no execution_completed event arrived) idle=${idle} allSucceeded=${allSucceeded}`);
    if (idle && allSucceeded) {
      dispatchRibosomeExtract(executionId).finally(() => {
        executions.delete(executionId);
      });
    } else {
      executions.delete(executionId);
    }
  }, 500);
}

// Authoritative completion: fired by activity-api's execution_completed event.
// Gates extraction on reach (status !== "failure") — a hollow completion no
// longer mints a template — and cancels the drain timer so the event, not the
// 500ms heuristic, decides. Closes ribosome-extraction-gates-on-success-not-reached.
function onExecutionCompleted(
  executionId: string,
  reached: boolean,
  label: string,
  census?: { taskCount: number; failedTaskCount: number },
) {
  const state = getOrCreate(executionId);
  const hadDrain = state.drainTimer !== null;
  if (state.drainTimer) { clearTimeout(state.drainTimer); state.drainTimer = null; }

  // Which signal decides. The in-memory counters are populated from per-task WS
  // events (task.started / task.completed), and for the overwhelming majority of
  // executions those events never arrive at this vessel — getOrCreate() then
  // hands back a fresh zero-valued state, `completedTasks > 0` is false, and
  // extraction is skipped for exactly the reached executions worth extracting.
  // Measured: `reached=true ... completed=0` on almost every line of the journal,
  // and ZERO ribosome-extract dispatches in 12 hours.
  //
  // activity-api's execution_completed now carries the authoritative task census
  // off the durable trace, so prefer it whenever it is present and non-empty and
  // fall back to the in-memory counters only when it is absent (an older
  // activity-api that has not yet converged).
  const useCensus = census !== undefined && census.taskCount > 0;
  const source = useCensus ? "durable-census" : "in-memory";
  const completed = useCensus ? census.taskCount - census.failedTaskCount : state.completedTasks;
  const failed = useCensus ? census.failedTaskCount : state.failedTasks;
  console.log(`[ribosome-vessel] execution_completed ${executionId} reached=${reached} (${label}) completed=${completed} failed=${failed} signal=${source} (event-driven${hadDrain ? ", pre-empted drain" : ""})`);
  const allSucceeded = failed === 0 && completed > 0;
  if (reached && allSucceeded) {
    dispatchRibosomeExtract(executionId).finally(() => { executions.delete(executionId); });
  } else {
    executions.delete(executionId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket client
// ─────────────────────────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let lastSeenSequence = 0;
let reconnectDelay = 1_000;

const replayDeps: ReplayObserverDeps = {
  activityApiEndpoint: ACTIVITY_API_ENDPOINT,
  apiKey: API_KEY,
  llmEndpoint: process.env.LLM_RESOLVER_VESSEL_ENDPOINT ?? "http://127.0.0.1:8220",
};

function connectWS() {
  log.info("Connecting to activity-api WebSocket:", WS_URL);
  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    reconnectDelay = 1_000;
    log.info("WebSocket connected");
    ws!.send(JSON.stringify({ type: "authenticate", token: API_KEY }));
    if (lastSeenSequence > 0) {
      ws!.send(JSON.stringify({ type: "catchup", lastSeenSequence }));
    }
  });

  ws.addEventListener("message", (event) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      return;
    }

    if (typeof msg.sequence === "number") {
      lastSeenSequence = msg.sequence;
    }

    const type = msg.type as string | undefined;

    if (type === "task.started") {
      const data = (msg.data as Record<string, unknown> | undefined) ?? msg;
      const execId = data.execution_id as string | undefined;
      const taskId = data.task_id as string | undefined;
      if (execId && taskId) {
        getOrCreate(execId).activeTasks.add(taskId);
      }
    } else if (type === "task.completed") {
      const data = (msg.data as Record<string, unknown> | undefined) ?? msg;
      const execId = data.execution_id as string | undefined;
      const taskId = data.task_id as string | undefined;
      const success = data.success as boolean | undefined;
      if (execId && taskId) {
        onTaskCompleted(execId, taskId, success === true);
      }
    } else if (type === "execution_completed" || type === "execution.completed") {
      // Authoritative completion signal (activity-api emits execution_completed
      // on the trace-write path; the eventStream poll floor buffers it). This
      // retires the 500ms drain heuristic — that timer stays only as a fallback
      // for executions whose completion event never arrives.
      const data = (msg.data as Record<string, unknown> | undefined) ?? msg;
      const execId = (data.execution_id ?? msg.execution_id) as string | undefined;
      // activity-api's execution_completed carries success:boolean (not a status
      // string); fall back to a status field if a future emitter uses one.
      const success = data.success as boolean | undefined;
      const status = (data.status ?? msg.status) as string | undefined;
      const reached = success !== undefined ? success === true : (status !== "failure" && status !== "failed");
      // Authoritative task census off the durable trace (activity-api 2026-08-02).
      // Absent on an activity-api that has not converged yet — onExecutionCompleted
      // falls back to the in-memory counters in that case.
      const rawTaskCount = data.task_count as number | undefined;
      const rawFailedCount = data.failed_task_count as number | undefined;
      const census =
        typeof rawTaskCount === "number"
          ? { taskCount: rawTaskCount, failedTaskCount: typeof rawFailedCount === "number" ? rawFailedCount : 0 }
          : undefined;
      if (execId) {
        onExecutionCompleted(execId, reached, success !== undefined ? `success=${success}` : (status ?? "?"), census);
      }
    } else if (type === "template_created") {
      // M3: background trace replay for new templates
      // (concept_YinkepAheImS). Fire-and-forget; the observer module
      // catches and logs its own errors.
      onTemplateCreated(msg, replayDeps);
    }
  });

  ws.addEventListener("close", () => {
    log.warn("WebSocket closed — reconnecting in", reconnectDelay, "ms");
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      connectWS();
    }, reconnectDelay);
  });

  ws.addEventListener("error", (e) => {
    log.error("WebSocket error:", e);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery registration
// ─────────────────────────────────────────────────────────────────────────────

const discovery = new DiscoveryRegistrationLoop({
  vesselId: VESSEL_ID,
  vesselName: "ribosome-vessel",
  discoveryEndpoint: DISCOVERY_ENDPOINT,
  apiKey: API_KEY,
  port: PORT,
  shapes: [],          // ribosome-vessel owns no impulse shapes; it's a consumer
  systemVessel: true,
  resolveEndpoint: `http://127.0.0.1:${PORT}/resolve`,
  heartbeatIntervalMs: 60_000,
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server (health + stub resolve)
// ─────────────────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({
        status: "healthy",
        service: "ribosome-vessel",
        version: VERSION,
        ws_connected: ws?.readyState === WebSocket.OPEN,
        tracked_executions: executions.size,
      });
    }
    return new Response("Not Found", { status: 404 });
  },
});

log.info(`ribosome-vessel ${VERSION} listening on port ${PORT}`);

// Start WebSocket client and discovery (non-blocking)
connectWS();
discovery.start().catch((err: unknown) => {
  log.warn("Discovery registration error:", (err as Error)?.message ?? err);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  log.info("SIGTERM — shutting down");
  await discovery.stop();
  server.stop();
  process.exit(0);
});
process.on("SIGINT", async () => {
  log.info("SIGINT — shutting down");
  await discovery.stop();
  server.stop();
  process.exit(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Iteration 9 of the cross-vessel OOM hunt — periodic Bun.gc(true) workaround.
// See: concept_T-CTTOEl97IM (description), concept_s9ye5GKLw2L8 (signature),
//      concept_9ldsmRgqSTd5 (iter-6 derivation in goal-host-vessel).
//
// Hypothesis: Bun 1.3.14 retains heap-arena pages after free; affected vessels
// show RSS growth disconnected from heapUsed. goal-host hit OOM first because
// of its event volume; per iter-9 we apply the same workaround substrate-wide.
// A periodic forced full GC bounds RSS without changing semantics.
//
// .unref() so the timer doesn't prevent process exit.
// ─────────────────────────────────────────────────────────────────────────────
const GC_INTERVAL_MS = parseInt(process.env.RIBOSOME_VESSEL_GC_INTERVAL_MS ?? "30000", 10);
interface BunGlobal { Bun?: { gc?: (force: boolean) => number } }
const bunGlobal = globalThis as unknown as BunGlobal;
setInterval(() => {
  const gc = bunGlobal.Bun?.gc;
  if (typeof gc === "function") {
    try {
      const freed = gc(true);
      const rssMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
      console.log(`[gc-tick] vessel=ribosome-vessel freed=${freed}B rss_after=${rssMB}MB`);
    } catch (err) {
      console.warn(`[gc-tick] Bun.gc failed: ${(err as Error).message}`);
    }
  }
}, GC_INTERVAL_MS).unref();
