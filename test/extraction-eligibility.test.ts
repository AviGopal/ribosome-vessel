import { describe, it, expect } from "bun:test";
import {
  MIN_TASK_COUNT_FALLBACK,
  SkipCounters,
  skipRulesFromPolicy,
  skipTagRule,
  trivialTaskCountSkip,
} from "../src/extraction-eligibility";

// Imports the pure module, not ../src/index: index.ts binds the vessel port on import,
// which collides with the live vessel wherever the gate runs.
//
// Once extraction works, the ribosome would mint from every reached trend-battery probe
// ("Compute the product A*B…"), a dozen or more an hour, and from one-task traces that
// are already one reusable template. Both are skipped before dispatch, and counted.
const fallback = skipRulesFromPolicy(null);
const reached4Tasks = { taskCount: 4 };

describe("probe / observe tag skip (must-fail)", () => {
  it("skips a reached multi-task trace tagged probe:trend-expectation-check", () => {
    expect(trivialTaskCountSkip(reached4Tasks.taskCount, fallback)).toBeNull();
    expect(skipTagRule(["operator:qa", "probe:trend-expectation-check", "reached:true"], fallback)).toBe("probe:*");
  });

  it("skips the legacy operator:trend-expectation-check tag", () => {
    expect(skipTagRule(["operator:trend-expectation-check", "reached:true"], fallback)).toBe("operator:trend-expectation-check");
  });

  it("skips a run dispatched in observe mode", () => {
    expect(skipTagRule(["learning_mode:observe"], fallback)).toBe("learning_mode:observe");
  });

  it("CONTROL: an untagged (non-probe) reached multi-task trace is still extracted", () => {
    expect(trivialTaskCountSkip(reached4Tasks.taskCount, fallback)).toBeNull();
    expect(skipTagRule(["operator:qa", "reached:true", "learning_mode:learn", "state_signature:0000abcd"], fallback)).toBeNull();
    expect(skipTagRule([], fallback)).toBeNull();
    expect(skipTagRule(undefined, fallback)).toBeNull();
  });

  it("does not over-match: a tag merely containing 'probe' is not a probe", () => {
    expect(skipTagRule(["goal:probe-the-registry", "operator:probe"], fallback)).toBeNull();
  });
});

describe("trivial task-count skip (must-fail)", () => {
  it("skips a 1-task trace", () => {
    expect(MIN_TASK_COUNT_FALLBACK).toBe(2);
    expect(trivialTaskCountSkip(1, fallback)).toBe("task_count<2");
  });

  it("CONTROL: a 2-task trace is not trivial", () => {
    expect(trivialTaskCountSkip(2, fallback)).toBeNull();
  });

  it("an unknown task count is NOT skipped — allow-biased on missing census", () => {
    expect(trivialTaskCountSkip(undefined, fallback)).toBeNull();
    expect(trivialTaskCountSkip(Number.NaN, fallback)).toBeNull();
    // 0 is how a missing census arrives (onExecutionCompleted treats it as no census), not an empty trace.
    expect(trivialTaskCountSkip(0, fallback)).toBeNull();
  });
});

describe("skips are counted by reason", () => {
  it("counts each skip under its reason, keyed by rule so keys stay bounded", () => {
    const c = new SkipCounters();
    c.count("task_count<2");
    c.count(`tag:${skipTagRule(["probe:trend-expectation-check"], fallback)}`);
    c.count(`tag:${skipTagRule(["probe:another-battery"], fallback)}`);
    expect(c.snapshot()).toEqual({ "task_count<2": 1, "tag:probe:*": 2 });
  });
});

describe("rules are read from extractionEligibilityPolicy (law 1), never widened by a bad value", () => {
  it("a valid policy replaces the literals", () => {
    const r = skipRulesFromPolicy({ minTaskCount: 3, skipTags: ["Operator:Smoke"], skipTagPrefixes: ["bench:"] });
    expect(r.fallbacks).toEqual([]);
    expect(trivialTaskCountSkip(2, r)).toBe("task_count<3");
    expect(skipTagRule(["operator:smoke"], r)).toBe("operator:smoke");
    expect(skipTagRule(["bench:x"], r)).toBe("bench:*");
    expect(skipTagRule(["probe:trend-expectation-check"], r)).toBeNull();
  });

  it("malformed fields fall back to the literals and are reported", () => {
    for (const pol of [
      { minTaskCount: 1000, skipTags: [], skipTagPrefixes: [""] },
      { minTaskCount: 0, skipTags: "probe:", skipTagPrefixes: [1] },
      { minTaskCount: 2.5 },
      {},
    ]) {
      const r = skipRulesFromPolicy(pol as Record<string, unknown>);
      expect(r.minTaskCount).toBe(MIN_TASK_COUNT_FALLBACK);
      expect(r.fallbacks).toEqual(["minTaskCount", "skipTags", "skipTagPrefixes"]);
      expect(skipTagRule(["probe:trend-expectation-check"], r)).toBe("probe:*");
      expect(skipTagRule(["operator:qa"], r)).toBeNull();
    }
  });
});
