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

// Executions already dispatched for extraction. activity-api's execution_completed
// can arrive more than once for the same execution (WS delivery plus the eventStream
// poll floor that buffers and replays), and `executions.delete()` in the dispatch
// `finally` frees the key so a replay re-creates a fresh state and dispatches again.
// Measured: 334 dispatches over 212 distinct executions in 20 minutes — up to 4x per
// execution, each one a full template run. Bounded so this cannot grow without limit
// on a long-lived process.
const dispatchedExecutions = new Set<string>();
const DISPATCHED_MAX = 5_000;

function markDispatched(executionId: string): boolean {
  if (dispatchedExecutions.has(executionId)) return false;
  if (dispatchedExecutions.size >= DISPATCHED_MAX) {
    // Drop the oldest ~10% (insertion-ordered) rather than clearing outright, so a
    // replay arriving right after a wrap does not immediately re-dispatch everything.
    let toDrop = Math.floor(DISPATCHED_MAX / 10);
    for (const k of dispatchedExecutions) {
      dispatchedExecutions.delete(k);
      if (--toDrop <= 0) break;
    }
  }
  dispatchedExecutions.add(executionId);
  return true;
}

// Shaped-policy resolve (LAW 1), factored out of onExecutionCompleted's inline
// extractionPolicy read so the eligibility gate reuses it rather than forking it.
// Resolves through DISCOVERY, never activity-api: activity-api's /v2/impulses/resolve
// switches on pointer.type and its default branch returns 404 `use_vessel_discovery`
// for any shape it does not itself store. Discovery's universal proxy forwards a
// non-discovery shape to its registered producer and takes a FLAT { pointer } body.
// Returns null on ANY failure — every caller must supply an allow-biased fallback,
// because null is the COMMON case: extractionPolicy resolved 0 of 1446 times in 6h.
async function resolveShapedPolicy(shapeType: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}),
      },
      body: JSON.stringify({ pointer: { type: shapeType } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    // A direct vessel resolve returns { body: {...} }; federated egress nests it under
    // { content: { value | content | body } }. Probe both envelopes.
    const c = j.content as Record<string, unknown> | undefined;
    return ((j.body ?? (c && typeof c === "object" ? (c.body ?? c.value ?? c) : undefined) ?? j) ?? {}) as Record<string, unknown>;
  } catch (err: unknown) {
    log.warn(`${shapeType} resolve error:`, (err as Error)?.message ?? err);
    return null;
  }
}

// NOT EXHAUSTIVE, AND KNOWN NOT TO BE. ias-executor-ts/src/templates/lifecycle/ holds
// SIX meta-templates (validator-dispatch, slot-binding, ribosome-extract,
// audit-test-report, debug-failing-audit, run-sensitivity-probe); all carry
// category:"meta" and five carry a `subscription`. Only these two are listed because
// only these two are measured high-volume-and-never-graded: 540 of 700 sampled hub
// rows, 0 of which ever carried a reached:* tag. The other four are left to the
// re-read on purpose — over-dropping is the unrecoverable direction.
// The list is a NAME list because the structural marker is not on the wire:
// activity-api's execution_completed (execution-traces.ts:3288-3289) emits
// activity_id/variant_id/success/census/duration/cost and NOTHING ELSE. Emitting
// `category` there is the durable fix and the standing demand this warn line records.
const UNGRADABLE_PRODUCERS_FALLBACK: readonly string[] = Object.freeze([
  "validator-dispatch",
  "slot-binding",
]);
const ELIGIBILITY_TTL_MS = 300_000;
let eligibilityCache: { list: readonly string[]; source: string; at: number } | null = null;

// TTL-CACHED, not per-event. The naive form awaits a discovery POST on every
// execution_completed — ~1476 per 6h, every one a guaranteed 404 (the registry serves
// llmModelPolicy / docFixPolicy / learningPolicy / repairPolicy and no extraction*),
// DOUBLING this vessel's dead policy traffic and putting a 5s transport deadline in
// front of a two-element string comparison. Caching keeps the law-1 read (a minted
// policy still widens the list within one TTL) at ~1 call per 5 min. Same discipline
// the extraction-route probe at :70-81 already uses ("probe once, cache for lifetime").
// Only a NON-EMPTY array of strings may replace the literal: an empty array would mean
// "drop nothing", and a malformed one must never be able to mean "drop everything".
async function ungradableProducers(): Promise<{ list: readonly string[]; source: string }> {
  const now = Date.now();
  if (eligibilityCache && now - eligibilityCache.at < ELIGIBILITY_TTL_MS) return eligibilityCache;
  let list = UNGRADABLE_PRODUCERS_FALLBACK;
  let source = "fallback-literal";
  const pol = await resolveShapedPolicy("extractionEligibilityPolicy");
  const raw = pol?.ungradableProducers;
  if (Array.isArray(raw) && raw.length > 0 && raw.every((x) => typeof x === "string")) {
    list = (raw as string[]).map((x) => x.toLowerCase());
    source = "extractionEligibilityPolicy";
  } else {
    log.warn(
      `extractionEligibilityPolicy unresolved — falling back to literal [${UNGRADABLE_PRODUCERS_FALLBACK.join(", ")}]; three further lifecycle meta-templates exist unlisted (audit-test-report, debug-failing-audit, run-sensitivity-probe)`,
    );
  }
  eligibilityCache = { list, source, at: now };
  return eligibilityCache;
}

interface ExtractLifecycle {
  executionId: string;
  status: string;
  taskCount: number;
  templateId: string;
  templateName: string;
  templateAuthor: string;
  durationMs: number;
  costUsd: number;
  depth: number;
  impulseCount: number;
  outputShapes: string[];
  hasGoalContext: boolean;
  qualityEligible: boolean;
}

async function dispatchRibosomeExtract(executionId: string, lifecycle?: ExtractLifecycle) {
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
        // ribosome-extract's first task, acquire_trace_signature, is behind a
        // conditional gate on {{lifecycle.qualityEligible}}. Dispatching with only
        // executionId leaves that placeholder unresolvable, and the engine fails the
        // whole chain at task 1 with UNRESOLVABLE_GATE — which is why this template
        // shows 1000+ executions at a 0% success rate. Its downstream LLM tasks read
        // the rest of the lifecycle payload too, so send the full object (the same
        // shape goal-host's mintReachedTrace stamps), not just the gate field.
        variables: { executionId, applyExtraction: true, ...(lifecycle ? { lifecycle } : {}) },
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

  // Drain timer: STATE EVICTION ONLY. It used to dispatch ribosome-extract 500ms
  // after the last task event, as a "fallback for when execution_completed never
  // arrives". It was never a fallback and it never once worked:
  //   - 906 of 934 extraction dispatches in a 40-minute window originated here,
  //     and goal-host failed every single one at task 1 with
  //     UNRESOLVABLE_GATE {{lifecycle.qualityEligible}}. A 0%-success path.
  //   - It CANNOT pass that gate: ExecutionState carries only counters, so there
  //     is no lifecycle to send. Fabricating one is worse than deleting the
  //     dispatch: qualityEligible=true would convert ~1500 loud failures/hour
  //     into ~1500 *successful* LLM extractions over executions the census
  //     deliberately rejected, and false would skip the chain silently.
  //   - It bypassed markDispatched() and the recursion-safety producer check,
  //     both of which live only on the event path: 0 dedupe skips observed while
  //     individual execution ids dispatched up to 4x.
  //   - It was not covering a gap. 94% of drained ids received an
  //     execution_completed 0-1s LATER, so it pre-empted and overrode the
  //     authoritative verdict rather than substituting for a missing one.
  // Extraction dispatch now lives solely in onExecutionCompleted, which owns the
  // durable-census gate, markDispatched, and recursion safety. Genuine WS gaps are
  // covered by lastSeenSequence catchup on reconnect, and goal-host's
  // mintReachedTrace runs ribosome-extract in-process on grounded reaches
  // independently of this vessel.
  if (state.drainTimer) clearTimeout(state.drainTimer);
  state.drainTimer = setTimeout(() => {
    executions.delete(executionId);
  }, 500);
}

// Authoritative completion: fired by activity-api's execution_completed event.
// Gates extraction on reach (status !== "failure") — a hollow completion no
// longer mints a template — and cancels the drain timer so the event, not the
// 500ms heuristic, decides. Closes ribosome-extraction-gates-on-success-not-reached.
async function onExecutionCompleted(
  executionId: string,
  reached: boolean,
  label: string,
  census?: { taskCount: number; completedTaskCount: number; failedTaskCount: number },
  meta?: { activityId: string; variantId: string; durationMs: number; costUsd: number },
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
  const completed = useCensus ? census.completedTaskCount : state.completedTasks;
  const failed = useCensus ? census.failedTaskCount : state.failedTasks;
  // Every task must be terminal AND successful. Task status is
  // 'pending' | 'in_progress' | 'completed' | 'failed', so requiring
  // completed === taskCount is what excludes a run abandoned mid-flight;
  // `failed === 0` alone would score its non-terminal tasks as fine and
  // extract a template from a partial execution.
  const allTerminal = !useCensus || completed === census!.taskCount;
  console.log(`[ribosome-vessel] execution_completed ${executionId} reached=${reached} (${label}) completed=${completed} failed=${failed}${useCensus ? `/${census!.taskCount}` : ""} signal=${source} (event-driven${hadDrain ? ", pre-empted drain" : ""})`);
  const allSucceeded = failed === 0 && completed > 0 && allTerminal;

  // Recursion safety. An extraction run is itself an execution that emits
  // execution_completed, so without this the ribosome extracts from its own
  // extractions. The template carries a recursion-safety rule in its LLM rubric, but
  // that only runs at task 3 — by then the run has already been dispatched, and if an
  // earlier task fails the rule never evaluates at all. Excluded here, at the source.
  // KEEP the prefix rejection (it still catches a producer that literally carries no
  // lineage marker) and ADD an extraction-DEPTH bound on the lineage marker. The prefix
  // test alone never fired on the ribosome's own descendants: extracted templates are
  // minted as `learned-…`, NOT `ribosome…`, so the vessel's own output was a legal
  // extraction source on the next generation. The live store shows the result —
  // `learned-report-top-failures-24h-proof-` x21, `…-improved-` x21, and ids of the form
  // `learned-learned-learned-auto-bridge-shellresult` that a live walk actually SELECTED.
  // Each generation is a further remove from any real execution.
  //
  // Reused marker: `learned-` is the ribosome's own deterministic mint prefix, so the
  // number of its occurrences in the producer id IS the generation counter. Extracted
  // templates carry metadata.extracted / metadata.extractedFrom but no depth field, and
  // this vessel receives only the producer id on the event — the id is the only lineage
  // signal available at use time. An id with no marker reads as depth 0 and is ALLOWED:
  // biasing toward blocking unmarked producers would block every ordinary non-extracted
  // execution and freeze extraction outright, the same silent capability outage as the
  // 12-hour zero-dispatch window noted above. Over-allowing costs at most one further
  // generation, which this same bound then stops.
  const producer = (meta?.variantId || meta?.activityId || "").toLowerCase();
  const isRibosomeFamily = producer.startsWith("ribosome");
  if (isRibosomeFamily) {
    console.log(`[ribosome-vessel] skip ${executionId} — recursion safety (producer=${producer})`);
    executions.delete(executionId);
    return;
  }
  // LAW 1: the bound is behavior, so it is read at USE TIME from the shaped
  // `extractionPolicy` impulse rather than frozen as a constant. It resolves through
  // DISCOVERY, not activity-api: activity-api's /v2/impulses/resolve switches on
  // pointer.type and its default branch returns 404 `use_vessel_discovery` for any shape
  // it does not itself store, so an extractionPolicy read there could never resolve and
  // the "shaped" policy would be decorative. Discovery's universal proxy forwards any
  // non-discovery shape to its registered producer and takes a FLAT { pointer } body.
  // The literal below applies ONLY when the resolve fails, and that fallback is LOGGED so
  // a missing policy producer is visible in the journal instead of silently becoming the
  // policy — which also makes the log line the standing demand signal for minting one.
  const extractionDepth = (producer.match(/learned-/g) ?? []).length;
  let maxExtractionDepth = 1;
  let depthPolicySource = "fallback-literal";
  {
    // Reuses the shared resolveShapedPolicy helper rather than forking a second copy
    // of the discovery/envelope logic — the guard below is unchanged.
    const policy = await resolveShapedPolicy("extractionPolicy");
    const v = policy?.maxExtractionDepth;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      maxExtractionDepth = v;
      depthPolicySource = "extractionPolicy";
    }
  }
  if (depthPolicySource === "fallback-literal") {
    log.warn("extractionPolicy unresolved — falling back to maxExtractionDepth", maxExtractionDepth);
  }
  if (extractionDepth > maxExtractionDepth) {
    console.log(`[ribosome-vessel] skip ${executionId} — extraction depth ${extractionDepth} > ${maxExtractionDepth} (producer=${producer}, policy=${depthPolicySource})`);
    executions.delete(executionId);
    return;
  }

  if (reached && allSucceeded) {
    if (!markDispatched(executionId)) {
      console.log(`[ribosome-vessel] skip ${executionId} — already dispatched for extraction`);
      executions.delete(executionId);
      return;
    }
    const lifecycle = {
      executionId,
      status: "completed",
      taskCount: useCensus ? census!.taskCount : completed,
      templateId: meta?.activityId ?? "",
      templateName: meta?.variantId || meta?.activityId || "",
      templateAuthor: "",
      durationMs: meta?.durationMs ?? 0,
      costUsd: meta?.costUsd ?? 0,
      depth: 0,
      impulseCount: 0,
      outputShapes: [] as string[],
      hasGoalContext: false,
      goalSignature: null,
      // The execution reached, which is the eligibility signal the template's gate
      // wants — the same justification goal-host's mintReachedTrace records.
      qualityEligible: true,
    };
    dispatchRibosomeExtract(executionId, lifecycle).finally(() => { executions.delete(executionId); });
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

/**
 * The reach verdict for a durable trace row. PURE — extracted so the three-state
 * behaviour can be pinned by a test; it was inline in the re-read loop and unassertable.
 *
 * READS THE COLUMN, NOT THE TAGS. `reached` is the verdict of record — an option<bool>
 * on `execution` that goal-host patches once the walk grades itself. Until 2026-09-02
 * the compat view did not PROJECT it, so this endpoint carried no such field and the
 * only reach signal reachable here was a `reached:*` string in `tags`. This loop
 * string-matched out of absence, not preference.
 *
 * Tags are caller-written and incomplete. From this vessel's own measurements: of 700
 * hub rows sampled, 540 were validator-dispatch / slot-binding and ZERO carried a
 * reached:* tag; the re-read loop scored 18 reached per 1476 re-reads (1.22%) on a fleet
 * whose honest reach is ~13%. The organ that extracts templates FROM REACHED EXECUTIONS
 * was starved by a read-path gap, not by a shortage of reached executions.
 *
 * THREE-STATE, and the third state is load-bearing. `null` means NEVER GRADED, not
 * "did not reach". Treating null as not-reached would brand every ungraded row a
 * failure — a worse version of the bug this replaces.
 *
 * TAGS REMAIN A FALLBACK, deliberately: an activity-api predating the projection fix
 * returns no `reached` key, and dropping the tag path would blind this vessel against
 * an older peer mid-rolling-deploy. Allow-biased, like the gradability gate.
 */
export function reachVerdictFromTraceRow(
  row: { tags?: unknown; reached?: unknown },
): { verdict: "reached" | "not-reached" | null; why: string } {
  const reachedField = row.reached;
  const tagsEarly = Array.isArray(row.tags) ? row.tags.map(String) : [];
  if (reachedField === true) return { verdict: "reached", why: "column:reached=true" };
  if (reachedField === false) {
    // SELF-CONTRADICTING ROW — reversal of this function's original rule (same day).
    //
    // The rule was "the column is the verdict of record; if they disagree the column
    // wins." Measured 2026-09-02, walk-satisfier-1-1788364637686 — the goal "count the
    // .ts files under repos/ribosome-vessel/src", answer 7, INDEPENDENTLY verified by a
    // host-side recount — carries in the live store, simultaneously:
    //
    //     status = success     tags = ["reached:true"]     reached = False
    //
    // `reached:true` comes from goal-host's GRADE-AT-INSERT path: written locally and
    // synchronously from the walk's own verdict. The column is derived at ingest and can
    // be written before that verdict exists — measured reach-patch lag runs to 586s. So on
    // this disagreement the TAG is the later, better-informed value, and the old rule made
    // this vessel discard a genuinely reached execution, starving the extraction it exists
    // to perform.
    //
    // ONE-DIRECTIONAL on purpose: only this lossy direction is overridden. It cannot
    // manufacture a false reach, because the tag carries the same verdict the patch itself
    // would have written. The `why` names the contradiction so the WRITE-side defect stays
    // visible in the journal rather than being silently papered over here.
    if (tagsEarly.includes("reached:true")) {
      return { verdict: "reached", why: "contradiction:column=false/tag=reached:true — trusting grade-at-insert tag" };
    }
    return { verdict: "not-reached", why: "column:reached=false" };
  }
  const tags = tagsEarly;
  if (tags.includes("reached:true")) return { verdict: "reached", why: "tag:reached:true" };
  if (tags.includes("reached:false")) return { verdict: "not-reached", why: "tag:reached:false" };
  return {
    verdict: null,
    why: reachedField === null ? "column-null-ungraded" : tags.length > 0 ? "no-reach-tag" : "no-tags",
  };
}

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
      // REACH IS NOT EXIT STATUS. `reached` used to be derived here from the event's
      // success:boolean — the template's exit status. Measured: 20,653 of 20,653
      // execution_completed events took that branch (19,417 true / 1,236 false, ZERO
      // fallbacks), yielding 94.0% "reached" on a system whose honest reach is ~13%.
      // The organ meant to extract templates FROM REACHED EXECUTIONS was extracting on
      // exit status — the pump that filled the arm pool with uninformed arms.
      //
      // The verdict CANNOT be computed at this boundary. activity-api's
      // execution_completed payload carries execution_id / activity_id / variant_id /
      // success / the task census / duration / cost — and NO `tags`. classifyReach, the
      // one honest-reach primitive, reads TAGS ONLY, so re-deriving a local notion of
      // reach here would fork that primitive (law 3). Enqueue UNGRADED and let the
      // durable row decide, below.
      const success = data.success as boolean | undefined;
      // Authoritative task census off the durable trace (activity-api 2026-08-02).
      // Absent on an activity-api that has not converged yet — onExecutionCompleted
      // falls back to the in-memory counters in that case.
      const rawTaskCount = data.task_count as number | undefined;
      const rawCompletedCount = data.completed_task_count as number | undefined;
      const rawFailedCount = data.failed_task_count as number | undefined;
      // Require completed_task_count too: an activity-api that sends task_count
      // but not completed_task_count predates the positive count, and guessing
      // (total - failed) there is exactly the over-counting this avoids.
      const census =
        typeof rawTaskCount === "number" && typeof rawCompletedCount === "number"
          ? {
              taskCount: rawTaskCount,
              completedTaskCount: rawCompletedCount,
              failedTaskCount: typeof rawFailedCount === "number" ? rawFailedCount : 0,
            }
          : undefined;
      const meta = {
        activityId: String(data.activity_id ?? ""),
        variantId: String(data.variant_id ?? ""),
        durationMs: typeof data.duration_ms === "number" ? data.duration_ms : 0,
        costUsd: typeof data.cost === "number" ? data.cost : 0,
      };
      if (execId) {
        const gradeId = execId;
        // THE RE-READ MUST OUTLAST THE VERDICT, NOT RACE IT. execution_completed is
        // emitted on the trace-WRITE path, during the walk; goal-host POSTs the reach
        // verdict only AFTER runGoalSeek returns and the reach gate has run. A single
        // immediate read is therefore structurally AHEAD of the verdict it waits for:
        // it would see no reach tag, score every execution 'ungraded', and drive
        // extraction to ~0% — a silent capability outage dressed up as honesty, and
        // exactly the failure this vessel's own comments already record ("ZERO
        // ribosome-extract dispatches in 12 hours").
        //
        // So poll with backoff and only give up once the verdict has had time to land.
        // Re-reading is idempotent and cheap next to an extraction dispatch, and a row
        // still untagged after the full window is genuinely ungraded — the walk never
        // produced a verdict — so skipping it is correct rather than merely early.
        // Waiting also absorbs the reach-patch write-before-insert race (8 of 8 sampled
        // MATCHED-NO-ROW ids existed on the hub seconds later), which is why a 404 is
        // treated as "keep waiting" and not as a verdict.
        void (async () => {
          // GRADABILITY GATE — RUNS BEFORE THE RE-READ, ON THE EVENT ALONE.
          //
          // WHAT THIS BUYS, STATED HONESTLY: COST, NOT HONESTY AND NOT REACH.
          // Extraction output is UNCHANGED by this gate. A lifecycle row today scores
          // verdict=ungraded, reaches onExecutionCompleted with reached=false, and falls
          // to the no-dispatch else branch — no extraction. After this gate: also no
          // extraction. Measured 31 ribosome-extract dispatches per 6h, invariant across
          // the change. What is saved is ~982 re-reads per 6h x 5 hub GETs each
          // (~4,900 GETs) and ~982 concurrently-held 75s closures.
          //
          // MEASURED SHARE (700 hub rows, 2026-08-06T07:13-10:41Z; 1476 journal re-reads,
          // 774 of them resolvable against that sample): validator-dispatch + slot-binding
          // are 515 of 721 UNGRADED re-reads (71.4%) and 515 of 774 total (66.5%). They
          // are 540 of 700 trace rows. ZERO of those 540 ever carried a reached:* tag and
          // ZERO of the 515 produced any verdict; every reach-tagged row in the sample
          // (23 false / 7 true) was a non-lifecycle producer. 1447 of 1476 ungraded
          // re-reads burned all 5 attempts to learn what the template id already said.
          //
          // ALLOW-BIASED, deliberately, exactly as the depth bound is. An unresolvable
          // policy, an empty or wrong-typed field, or unreachable discovery leaves the two
          // literals in place — it must never widen into "drop unless allow-listed", which
          // would read from the journal as perfect honesty while extracting nothing.
          //
          // EQUALITY, not substring. Real rows carry the bare id for exactly these two
          // (450 `validator-dispatch`, 90 `slot-binding`) while every other template's
          // variant_id is the record-id form `activity:⟨name⟩` — substring would swallow
          // a learned template whose name merely contains the marker. An empty producer
          // never matches, so a malformed event falls through to the re-read (safe).
          const producerId = (meta.variantId || meta.activityId || "").toLowerCase();
          const { list: ungradable, source: eligibilitySource } = await ungradableProducers();
          if (producerId && ungradable.includes(producerId)) {
            // Clear the drain timer first: onExecutionCompleted does this before every
            // one of its early returns, and this gate bypasses that path entirely.
            const st = executions.get(gradeId);
            if (st?.drainTimer) { clearTimeout(st.drainTimer); st.drainTimer = null; }
            log.info(
              `skip ${gradeId} — ungradable producer (producer=${producerId}, policy=${eligibilitySource}) — re-read avoided`,
            );
            executions.delete(gradeId);
            return;
          }

          const REREAD_BACKOFF_MS = [2_000, 8_000, 20_000, 45_000];
          let verdict: "reached" | "not-reached" | "ungraded" = "ungraded";
          let why = "unread";
          let attempts = 0;
          for (let i = 0; i <= REREAD_BACKOFF_MS.length; i++) {
            if (i > 0) await new Promise((r) => setTimeout(r, REREAD_BACKOFF_MS[i - 1]));
            attempts = i + 1;
            try {
              const traceRes = await fetch(
                `${ACTIVITY_API_ENDPOINT}/v2/activities/execution-traces/${encodeURIComponent(gradeId)}`,
                {
                  headers: { ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
                  // Transport deadline, not a behavior gate.
                  signal: AbortSignal.timeout(15_000),
                },
              );
              if (traceRes.ok) {
                const row = await traceRes.json() as { tags?: unknown; reached?: unknown };
                const d = reachVerdictFromTraceRow(row);
                why = d.why;
                if (d.verdict !== null) { verdict = d.verdict; break; }
              } else {
                why = `http-${traceRes.status}`;
              }
            } catch (err: unknown) {
              why = `error:${(err as Error)?.message ?? String(err)}`;
            }
          }
          // ROLLBACK TRIGGER — ABSOLUTE, NOT A RATIO. This was formerly "if
          // verdict=reached stays under ~2% of these lines, revert". That threshold is
          // dead: it read 1.22% (18 reached / 1476 re-reads per 6h) — ALREADY TRIPPED,
          // never acted on — and the gradability gate above lifts it to ~3.6% purely by
          // removing ~982 ungradable rows from the DENOMINATOR, with zero change to the
          // numerator. A gate that clears its own rollback trigger by shrinking the
          // denominator is a gamed metric, so the trigger is now stated in units this
          // filter cannot move: EXTRACTION DISPATCHES PER 6H, baseline 31 (measured
          // 2026-08-06 over the same 1476-re-read window). If `Dispatching
          // ribosome-extract` falls below ~25/6h, this gate is starving extraction and
          // should be reverted rather than tuned.
          //
          // Direct over-drop probe: any `ungradable producer` skip line whose execution
          // id, resolved on the hub 10+ minutes later, carries a reached:* tag. Expected
          // count is exactly ZERO (0 of 540 sampled lifecycle rows, 0 of 515 lifecycle
          // re-reads), so a SINGLE occurrence falsifies the filter's premise.
          log.info(
            `reach re-read ${gradeId} verdict=${verdict} (${why}) attempts=${attempts} event_success=${String(success)} —`,
            verdict === "reached" ? "extraction ALLOWED" : "extraction SKIPPED (not honestly reached)",
          );
          await onExecutionCompleted(gradeId, verdict === "reached", `durable:${verdict}/${why}`, census, meta);
        })().catch((err: unknown) => log.warn("reach re-read failed:", (err as Error)?.message ?? err));
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
