/**
 * Extraction eligibility — which reached executions the ribosome must NOT extract from,
 * decided before any extraction is dispatched. PURE and side-effect free, so it can be
 * pinned by a test without importing index.ts (which binds the vessel port on import).
 *
 * Two skips, each counted by reason:
 *
 *   1. TRIVIAL TASK COUNT. A trace with one task or none is already one reusable
 *      template; extracting it clones the source with a runtime-derived input contract.
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
/** Exact tags that mark a trace as not to be extracted. */
export const SKIP_TAGS_FALLBACK: readonly string[] = Object.freeze([
  // Legacy trend-battery tag, kept while the battery moves to probe:trend-expectation-check.
  "operator:trend-expectation-check",
  "learning_mode:observe",
  "reach_observe:true",
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
  if (typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= MAX_MIN_TASK_COUNT) minTaskCount = m;
  else fallbacks.push("minTaskCount");
  let skipTags = nonEmptyStrings(pol?.skipTags) as readonly string[] | null;
  if (!skipTags) { skipTags = SKIP_TAGS_FALLBACK; fallbacks.push("skipTags"); }
  let skipTagPrefixes = nonEmptyStrings(pol?.skipTagPrefixes) as readonly string[] | null;
  if (!skipTagPrefixes) { skipTagPrefixes = SKIP_TAG_PREFIXES_FALLBACK; fallbacks.push("skipTagPrefixes"); }
  return { minTaskCount, skipTags, skipTagPrefixes, fallbacks };
}

/**
 * The trivial-task-count skip. `taskCount` is the durable census off the
 * execution_completed event; when it is absent (an activity-api that predates the
 * census) the count is unknown and the trace is NOT skipped — allow-biased, because a
 * skip on missing data would silently stop extraction outright.
 */
export function trivialTaskCountSkip(taskCount: number | undefined, rules: SkipRules): string | null {
  if (typeof taskCount !== "number" || !Number.isFinite(taskCount)) return null;
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
