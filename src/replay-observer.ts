/**
 * TemplateReplayObserver — M3: background trace replay for new templates.
 *
 * Concept: concept_YinkepAheImS (background_trace_replay_for_new_templates).
 * Spec: openspec/changes/2026-06-04-learning-rate-3-background-trace-replay/proposal.md
 *
 * Mechanism (MVP):
 *   1. Receive a `template_created` WS event with the new template's
 *      id, input_shapes, output_shapes, and tasks.
 *   2. Fetch up to N (default 3) recent historical execution traces from
 *      activity-api whose `input_impulse_shapes` are a superset of the new
 *      template's `input_shapes`.
 *   3. For each trace, ask llm-resolver-vessel (`llm_completion` resolver)
 *      whether the new template's task graph would plausibly have succeeded
 *      on the recorded inputs and outcome. Expect a JSON {score, confidence}.
 *   4. Write one `impulseRelevance_write` per replay, weight = REPLAY_WEIGHT,
 *      tagged `source: "background_replay"` and `replay_trace_id`.
 *
 * Abort-on-imbalance: if the FIRST replay times out, returns a non-2xx, or
 * produces unparseable JSON, abort the remaining replays for this template.
 *
 * Cost cap: MAX_REPLAYS_PER_TEMPLATE (default 3). Non-MVP corners
 * (stratified sampling over context_bucket, importance-weighted shrinkage,
 * abort-on-imbalance-by-Δβ-ratio, queue persistence across restarts) are
 * explicitly deferred — see proposal §"Math" and §"Architecture".
 */

const REPLAY_WEIGHT = parseFloat(process.env.RIBOSOME_REPLAY_WEIGHT ?? "0.3");
const MAX_REPLAYS_PER_TEMPLATE = parseInt(
  process.env.RIBOSOME_REPLAY_MAX_PER_TEMPLATE ?? "3",
  10,
);
const REPLAY_LLM_TIMEOUT_MS = parseInt(
  process.env.RIBOSOME_REPLAY_LLM_TIMEOUT_MS ?? "30000",
  10,
);
const REPLAY_TRACE_FETCH_LIMIT = parseInt(
  process.env.RIBOSOME_REPLAY_TRACE_FETCH_LIMIT ?? "100",
  10,
);

const LLM_RESOLVER_ENDPOINT =
  process.env.LLM_RESOLVER_VESSEL_ENDPOINT ?? "http://127.0.0.1:8220";

export interface TemplateCreatedEventData {
  template_id?: string;
  activity_id?: string;
  name?: string | null;
  input_shapes?: string[];
  output_shapes?: string[];
  tasks?: unknown[];
  org_id?: string | null;
  account_id?: string | null;
}

export interface HistoricalTrace {
  execution_id: string;
  activity_id?: string;
  variant_id?: string;
  success?: boolean;
  input_impulse_shapes?: string[];
  output_impulse_shapes?: string[];
  duration_ms?: number;
  executed_at?: string;
}

export interface ReplayJudgement {
  score: number;       // 0..1 — counterfactual success likelihood
  confidence: number;  // 0..1 — judge confidence
  divergent_task?: string;
  raw?: string;
}

const log = {
  info: (...a: unknown[]) => console.log("[replay-observer]", ...a),
  warn: (...a: unknown[]) => console.warn("[replay-observer] WARN", ...a),
  error: (...a: unknown[]) => console.error("[replay-observer] ERROR", ...a),
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for unit testing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a `template_created` WS message into the strongly-typed event data.
 * Returns null if the message is malformed (missing template_id and
 * activity_id, or no input_shapes array).
 */
export function parseTemplateCreatedEvent(
  msg: unknown,
): { templateId: string; inputShapes: string[]; data: TemplateCreatedEventData } | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== "template_created") return null;
  const data = (m.data ?? {}) as TemplateCreatedEventData;
  const templateId =
    (typeof data.template_id === "string" && data.template_id) ||
    (typeof data.activity_id === "string" && data.activity_id) ||
    null;
  if (!templateId) return null;
  const inputShapes = Array.isArray(data.input_shapes)
    ? data.input_shapes.filter((s): s is string => typeof s === "string")
    : [];
  return { templateId, inputShapes, data };
}

/**
 * Subset match: returns true if every shape in `needed` is present in `have`.
 * Empty `needed` means "matches everything".
 */
export function tracesMatchShapes(
  trace: HistoricalTrace,
  needed: string[],
): boolean {
  if (needed.length === 0) return true;
  const have = new Set(trace.input_impulse_shapes ?? []);
  for (const s of needed) {
    if (!have.has(s)) return false;
  }
  return true;
}

/**
 * Filter and cap a list of historical traces to the ones that satisfy
 * the new template's input_shapes contract.
 */
export function selectReplayTraces(
  traces: HistoricalTrace[],
  inputShapes: string[],
  cap: number,
): HistoricalTrace[] {
  const matching = traces.filter((t) => tracesMatchShapes(t, inputShapes));
  return matching.slice(0, cap);
}

/**
 * Build the counterfactual-judgement prompt for one trace.
 */
export function buildReplayPrompt(
  template: TemplateCreatedEventData,
  trace: HistoricalTrace,
): string {
  return [
    "You are a counterfactual-evaluation judge for an activity-execution learning loop.",
    "",
    "A NEW activity template has just been authored. Decide whether it would PLAUSIBLY have produced the same outcome on the recorded inputs as the trace below.",
    "",
    "NEW TEMPLATE:",
    "  id: " + (template.template_id ?? template.activity_id ?? "<unknown>"),
    "  name: " + (template.name ?? "<unnamed>"),
    "  input_shapes: " + JSON.stringify(template.input_shapes ?? []),
    "  output_shapes: " + JSON.stringify(template.output_shapes ?? []),
    "  tasks: " + JSON.stringify(template.tasks ?? [], null, 2),
    "",
    "RECORDED TRACE:",
    "  execution_id: " + trace.execution_id,
    "  template_executed: " + (trace.activity_id ?? trace.variant_id ?? "<unknown>"),
    "  input_impulse_shapes: " + JSON.stringify(trace.input_impulse_shapes ?? []),
    "  output_impulse_shapes: " + JSON.stringify(trace.output_impulse_shapes ?? []),
    "  outcome: " + (trace.success ? "success" : "failure"),
    "  duration_ms: " + (trace.duration_ms ?? "unknown"),
    "",
    "Respond with ONLY a single-line JSON object, no prose, no markdown fences:",
    '  {"score": <0..1>, "confidence": <0..1>, "divergent_task": "<task_id or empty>"}',
    "",
    "score = probability the new template would have produced the recorded outcome shapes.",
    "confidence = your confidence in this judgement.",
    "divergent_task = the id of the first task in the new template that would have differed; empty string if none.",
  ].join("\n");
}

/**
 * Parse the LLM's response into a ReplayJudgement. Returns null when
 * unparseable, which is the abort-on-imbalance trigger.
 */
export function parseReplayJudgement(raw: string): ReplayJudgement | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // Tolerate trailing whitespace, markdown fences, or prose around the JSON.
  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const score = typeof parsed.score === "number" ? parsed.score : NaN;
    const confidence =
      typeof parsed.confidence === "number" ? parsed.confidence : NaN;
    if (!Number.isFinite(score) || !Number.isFinite(confidence)) return null;
    if (score < 0 || score > 1 || confidence < 0 || confidence > 1) return null;
    const divergentTask =
      typeof parsed.divergent_task === "string" && parsed.divergent_task.length > 0
        ? parsed.divergent_task
        : undefined;
    return {
      score,
      confidence,
      ...(divergentTask ? { divergent_task: divergentTask } : {}),
      raw,
    };
  } catch {
    return null;
  }
}

/**
 * Construct the relevanceData payload for impulseRelevance_write from a
 * replay judgement. The α/β delta interpretation lives downstream in
 * activity-api's /impulse-relevance handler — here we only set the success
 * flag, the source tags, and the replay weight.
 */
export function buildRelevancePayload(
  template: TemplateCreatedEventData,
  trace: HistoricalTrace,
  judgement: ReplayJudgement,
  weight: number,
): Record<string, unknown> {
  const templateId =
    template.template_id ?? template.activity_id ?? "<unknown>";
  // Use the historical trace's first input shape as a synthetic impulse_id
  // when no per-impulse id is available — keeps the (impulse_id, variant_id)
  // aggregation key meaningful for replay-sourced rows.
  const impulseId =
    `replay:${trace.execution_id}:${(trace.input_impulse_shapes ?? ["unknown"])[0]}`;
  return {
    impulse_id: impulseId,
    activity_variant_id: templateId,
    execution_id: trace.execution_id,
    was_loaded: true,
    execution_succeeded: judgement.score >= 0.5,
    source: "background_replay",
    replay_trace_id: trace.execution_id,
    replay_weight: weight,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O — kept thin so it can be swapped/mocked in tests.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReplayObserverDeps {
  activityApiEndpoint: string;
  apiKey: string;
  llmEndpoint?: string;
  fetchImpl?: typeof fetch;
}

async function fetchRecentTraces(
  deps: ReplayObserverDeps,
  limit: number,
): Promise<HistoricalTrace[]> {
  const f = deps.fetchImpl ?? fetch;
  const url =
    deps.activityApiEndpoint +
    "/v2/activities/execution-traces?limit=" +
    String(limit) +
    "&success=true";
  const res = await f(url, {
    method: "GET",
    headers: {
      Authorization: `ApiKey ${deps.apiKey}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`fetchRecentTraces HTTP ${res.status}`);
  }
  const body = (await res.json()) as { executions?: HistoricalTrace[]; traces?: HistoricalTrace[]; data?: HistoricalTrace[] };
  // The GET /execution-traces response shape varies a little by version;
  // tolerate the three known wrappers.
  const list = body.executions ?? body.traces ?? body.data ?? [];
  return Array.isArray(list) ? list : [];
}

async function callJudge(
  deps: ReplayObserverDeps,
  prompt: string,
): Promise<string> {
  const f = deps.fetchImpl ?? fetch;
  const url = (deps.llmEndpoint ?? LLM_RESOLVER_ENDPOINT) + "/resolve";
  const res = await f(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `ApiKey ${deps.apiKey}`,
    },
    body: JSON.stringify({
      type: "llm_completion",
      prompt,
      max_tokens: 256,
    }),
    signal: AbortSignal.timeout(REPLAY_LLM_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`callJudge HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    resolved?: boolean;
    content?: string;
    body?: { content?: string };
    error?: string;
  };
  if (body.error) throw new Error(`callJudge resolver error: ${body.error}`);
  return body.content ?? body.body?.content ?? "";
}

async function writeRelevance(
  deps: ReplayObserverDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  const url = deps.activityApiEndpoint + "/v2/impulses/resolve";
  const res = await f(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `ApiKey ${deps.apiKey}`,
    },
    body: JSON.stringify({
      impulse: {
        pointer: {
          type: "impulseRelevance_write",
          relevanceData: payload,
        },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`writeRelevance HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-template replay job
// ─────────────────────────────────────────────────────────────────────────────

export async function runReplayJob(
  template: TemplateCreatedEventData,
  inputShapes: string[],
  deps: ReplayObserverDeps,
): Promise<{ attempted: number; written: number; aborted: boolean; reason?: string }> {
  const templateId =
    template.template_id ?? template.activity_id ?? "<unknown>";
  log.info("Replay job start", { templateId, inputShapes });

  let allTraces: HistoricalTrace[];
  try {
    allTraces = await fetchRecentTraces(deps, REPLAY_TRACE_FETCH_LIMIT);
  } catch (err) {
    log.warn("Failed to fetch historical traces", {
      templateId,
      error: (err as Error)?.message ?? String(err),
    });
    return { attempted: 0, written: 0, aborted: true, reason: "fetch_failed" };
  }

  const candidates = selectReplayTraces(
    allTraces,
    inputShapes,
    MAX_REPLAYS_PER_TEMPLATE,
  );
  if (candidates.length === 0) {
    log.info("Replay no matches", { templateId, totalScanned: allTraces.length });
    return { attempted: 0, written: 0, aborted: false, reason: "no_matches" };
  }

  let attempted = 0;
  let written = 0;
  for (const trace of candidates) {
    attempted++;
    const prompt = buildReplayPrompt(template, trace);
    let raw: string;
    try {
      raw = await callJudge(deps, prompt);
    } catch (err) {
      log.warn("Judge call failed — aborting remaining replays", {
        templateId,
        traceId: trace.execution_id,
        error: (err as Error)?.message ?? String(err),
      });
      return {
        attempted,
        written,
        aborted: true,
        reason: attempted === 1 ? "first_replay_failed" : "subsequent_replay_failed",
      };
    }
    const judgement = parseReplayJudgement(raw);
    if (!judgement) {
      log.warn("Unparseable judge response — aborting remaining replays", {
        templateId,
        traceId: trace.execution_id,
        rawPreview: raw.slice(0, 200),
      });
      return {
        attempted,
        written,
        aborted: true,
        reason: "malformed_judgement",
      };
    }
    const payload = buildRelevancePayload(template, trace, judgement, REPLAY_WEIGHT);
    try {
      await writeRelevance(deps, payload);
      written++;
      log.info("Replay written", {
        templateId,
        traceId: trace.execution_id,
        score: judgement.score,
        confidence: judgement.confidence,
      });
    } catch (err) {
      log.warn("Relevance write failed", {
        templateId,
        traceId: trace.execution_id,
        error: (err as Error)?.message ?? String(err),
      });
      // Don't abort on write failures — surface as low written count instead.
    }
  }

  log.info("Replay job done", { templateId, attempted, written });
  return { attempted, written, aborted: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point for the WS handler.
// ─────────────────────────────────────────────────────────────────────────────

const inFlight = new Set<string>();

export function onTemplateCreated(
  msg: unknown,
  deps: ReplayObserverDeps,
): void {
  const parsed = parseTemplateCreatedEvent(msg);
  if (!parsed) return;
  if (inFlight.has(parsed.templateId)) {
    log.info("Replay already in flight; skipping duplicate", { templateId: parsed.templateId });
    return;
  }
  inFlight.add(parsed.templateId);
  // Fire-and-forget; we never throw into the WS loop.
  runReplayJob(parsed.data, parsed.inputShapes, deps)
    .catch((err: unknown) => {
      log.error("Replay job unhandled error", {
        templateId: parsed.templateId,
        error: (err as Error)?.message ?? String(err),
      });
    })
    .finally(() => {
      inFlight.delete(parsed.templateId);
    });
}
