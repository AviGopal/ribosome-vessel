/**
 * Extraction eligibility — which reached executions the ribosome must NOT extract from,
 * decided before any extraction is dispatched. PURE and side-effect free, so it can be
 * pinned by a test without importing index.ts (which binds the vessel port on import).
 *
 * Three skips, each counted by reason:
 *
 *   1. TRIVIAL TASK COUNT. A trace with one task is already one reusable template;
 *      extracting it clones the source with a runtime-derived input contract. A count of
 *      0 is the census being absent (onExecutionCompleted reads it the same way), not an
 *      empty trace, so it is not skipped.
 *      goal-host's mintReachedTrace refuses the same class (`tasks.length <= 1`), so this
 *      is the same rule on the vessel's own trigger, not a new one.
 *
 *   2. PROBE / OBSERVE TAGS. A probe is a measurement of the substrate, not work it
 *      learned to do. The trend battery's "Compute the product A*B…" goals reach often,
 *      and once extraction works each would mint a template: a dozen or more an hour,
 *      flooding the catalogue with copies of a measurement. A probe trace is typically
 *      compute + memoryNote_write = 2 tasks, so the task-count skip alone does not catch
 *      it. `learning_mode:observe` is the dispatch's own statement that it must not
 *      teach; extracting from it would teach.
 *
 *   3. GOAL-HOST-OWNED TRACES (`dispatcher_used:goal-host`). goal-host's reach->mint gate
 *      (mintReachedTrace) already decides, per reach, whether the run is an extractable
 *      recipe, and runs ribosome-extract itself when it is. When it refuses (ungrounded,
 *      credit hold, foreign consumption, defer, depth, trivial) the refusal is a log line
 *      only, never a field on the trace, so this vessel saw just `reached=true` and
 *      extracted what goal-host had refused: a constant-SVG emitter and an unbound
 *      web-search composition, both from judge-only reaches. Extracting a goal-host trace
 *      here is therefore either a duplicate of goal-host's own mint or an override of its
 *      refusal. Skipped on the same tag rule as (2); the policy may replace the list.
 *      FAIL CLOSED when the row names NO dispatcher: goal-host's sync /resolve surface
 *      walks with no tags at all, so its reached rows carry no `dispatcher_used:*` and
 *      would otherwise slip past (3). The only other dispatcher that grades reach,
 *      light-dispatch, stamps `dispatcher_used:light-dispatch`. An absent dispatcher is an
 *      absent mint decision, so this rule is structural, not a policy field: a policy
 *      that dropped it would reopen the override of goal-host's refusal.
 *
 * LAW 1: the threshold and the tag lists are behaviour, so they are read at use time from
 * the shaped `extractionEligibilityPolicy` impulse, the same policy that already carries
 * `ungradableProducers`. The literals below apply only when that policy is absent or a
 * field is malformed, and a malformed field never widens the skip: only a non-empty array
 * of strings replaces a list, and only an integer in [1, MAX_MIN_TASK_COUNT] replaces the
 * threshold, so no policy value can mean "skip everything".
 */

export const MIN_TASK_COUNT_FALLBACK = 2;
/** Upper bound a policy may set the threshold to; past it the value is treated as malformed. */
export const MAX_MIN_TASK_COUNT = 10;
/** The tag goal-host stamps on every trace it dispatches; its reach->mint gate owns those. */
export const GOAL_HOST_OWNED_TAG = "dispatcher_used:goal-host";
/** Exact tags that mark a trace as not to be extracted. */
export const SKIP_TAGS_FALLBACK: readonly string[] = Object.freeze([
  // Legacy trend-battery tag, kept while the battery moves to probe:trend-expectation-check.
  "operator:trend-expectation-check",
  "learning_mode:observe",
  // goal-host's mintReachedTrace owns the mint decision for its own dispatches, and its
  // refusal is not persisted on the trace, so a reached goal-host row is not ours to extract.
  GOAL_HOST_OWNED_TAG,
]);
/** Tag prefixes that mark a trace as not to be extracted. */
export const SKIP_TAG_PREFIXES_FALLBACK: readonly string[] = Object.freeze(["probe:"]);

export interface SkipRules {
  minTaskCount: number;
  skipTags: readonly string[];
  skipTagPrefixes: readonly string[];
  /** Fields that fell back to the literal, so the caller can log the demand for a producer. */
  fallbacks: string[];
}

function nonEmptyStrings(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((x) => typeof x === "string" && x.length > 0)) return null;
  return (raw as string[]).map((x) => x.toLowerCase());
}

/** Read the skip rules out of a resolved extractionEligibilityPolicy body (or null). */
export function skipRulesFromPolicy(pol: Record<string, unknown> | null): SkipRules {
  const fallbacks: string[] = [];
  let minTaskCount = MIN_TASK_COUNT_FALLBACK;
  const m = pol?.minTaskCount;
  if (typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= MAX_MIN_TASK_COUNT) {
    minTaskCount = m;
  } else if (pol) {
    fallbacks.push("minTaskCount");
  }
  let skipTags = nonEmptyStrings(pol?.skipTags) as readonly string[] | null;
  if (!skipTags) {
    skipTags = SKIP_TAGS_FALLBACK;
    if (pol) fallbacks.push("skipTags");
  }
  let skipTagPrefixes = nonEmptyStrings(pol?.skipTagPrefixes) as readonly string[] | null;
  if (!skipTagPrefixes) {
    skipTagPrefixes = SKIP_TAG_PREFIXES_FALLBACK;
    if (pol) fallbacks.push("skipTagPrefixes");
  }
  return { minTaskCount, skipTags, skipTagPrefixes, fallbacks };
}

/**
 * The trivial-task-count skip. `taskCount` is the durable census off the
 * execution_completed event; when it is absent, or 0 (how a missing census arrives),
 * the count is unknown and the trace is NOT skipped — allow-biased, because a skip on
 * missing data would silently stop extraction outright.
 */
export function trivialTaskCountSkip(taskCount: number | undefined, rules: SkipRules): string | null {
  if (typeof taskCount !== "number" || !Number.isFinite(taskCount) || taskCount < 1) return null;
  return taskCount < rules.minTaskCount ? `task_count<${rules.minTaskCount}` : null;
}

/**
 * The probe/observe tag skip, on the durable row's tags (the execution_completed event
 * carries none). Returns the RULE that matched (`probe:*` or the exact tag), not the tag
 * itself, so the counters keyed by it stay bounded however many probe names exist.
 */
export function skipTagRule(tags: unknown, rules: SkipRules): string | null {
  if (!Array.isArray(tags)) return null;
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const t = raw.toLowerCase();
    if (rules.skipTags.includes(t)) return t;
    const p = rules.skipTagPrefixes.find((pre) => t.startsWith(pre));
    if (p) return `${p}*`;
  }
  return null;
}

/** The rule name for a row that carries no `dispatcher_used:*` tag (skip 3, fail closed). */
export const DISPATCHER_ABSENT_RULE = "dispatcher_used:absent";

/** Skip 3's fail-closed half: no `dispatcher_used:*` tag on the row (or no tags at all). */
export function dispatcherAbsentRule(tags: unknown): string | null {
  const hasDispatcher = Array.isArray(tags)
    && tags.some((t) => typeof t === "string" && t.toLowerCase().startsWith("dispatcher_used:"));
  return hasDispatcher ? null : DISPATCHER_ABSENT_RULE;
}

/** Why a matched tag rule skips extraction, for the skip log line a person reads. */
export function skipTagReason(rule: string): string {
  if (rule === GOAL_HOST_OWNED_TAG) return "goal-host's reach->mint owns it";
  if (rule === DISPATCHER_ABSENT_RULE) return "no dispatcher named, so no mint decision to honour; fail closed";
  return "probe/observe run";
}

/** Skip counts by reason, served on /health so a skip is observable without the journal. */
export class SkipCounters {
  private readonly counts = new Map<string, number>();
  count(reason: string): number {
    const n = (this.counts.get(reason) ?? 0) + 1;
    this.counts.set(reason, n);
    return n;
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}
