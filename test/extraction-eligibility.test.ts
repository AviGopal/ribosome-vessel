import { describe, it, expect } from "bun:test";
import {
  MIN_TASK_COUNT_FALLBACK,
  SkipCounters,
  skipRulesFromPolicy,
  skipTagRule,
  trivialTaskCountSkip,
} from "../src/extraction-eligibility";
// Namespace import for a helper the fix adds, so the parent commit fails the assertions by
// name rather than failing to load the file.
import * as eligibility from "../src/extraction-eligibility";

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

  it("CONTROL: a non-probe reached multi-task trace is not skipped by the tag rule", () => {
    // A row naming no dispatcher at all is skipped by the fail-closed rule below, not here.
    expect(trivialTaskCountSkip(reached4Tasks.taskCount, fallback)).toBeNull();
    expect(skipTagRule(["dispatcher_used:light-dispatch", "operator:qa", "reached:true", "learning_mode:learn", "state_signature:0000abcd"], fallback)).toBeNull();
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

describe("goal-host-owned traces are not extracted here (must-fail)", () => {
  // The durable rows' exact tags. goal-host refused both (SKIP ungrounded; CREDIT HELD at
  // mintReachedTrace) in log lines only, and this vessel extracted both off reached=true.
  const grb13zc4 = ["surface:do-anything", "state_signature:4cdd6171", "dispatcher_used:goal-host", "operator:human-surface", "dispatch:41e6f926-5ba6-4669-8e2e-1534555ecc40", "reach_graded:true", "reached:true"];
  const pw8eov = ["surface:do-anything", "state_signature:4cdd6171", "dispatcher_used:goal-host", "operator:human-surface", "dispatch:af7c27a6-b5f7-427b-9255-f6440721c97a", "composite:true", "reached:true"];

  // The rule index.ts applies to a reached row: the policy tag rules, then the fail-closed
  // dispatcher check. A fix that only adds the tag still leaves untagged rows extractable.
  const ruleFor = (tags: unknown) => skipTagRule(tags, fallback) ?? (eligibility.dispatcherAbsentRule?.(tags) ?? null);

  it("skips the reached house-SVG trace goal-host refused as ungrounded", () => {
    expect(trivialTaskCountSkip(2, fallback)).toBeNull();
    expect(ruleFor(grb13zc4)).toBe("dispatcher_used:goal-host");
  });

  it("skips the reached web-search composite goal-host's credit hold refused", () => {
    expect(trivialTaskCountSkip(2, fallback)).toBeNull();
    expect(ruleFor(pw8eov)).toBe("dispatcher_used:goal-host");
  });

  it("logs the skip with goal-host's ownership as the reason; the probe/observe wording is unchanged", () => {
    expect(eligibility.skipTagReason?.("dispatcher_used:goal-host")).toBe("goal-host's reach->mint owns it");
    expect(eligibility.skipTagReason?.("probe:*")).toBe("probe/observe run");
    expect(eligibility.skipTagReason?.("learning_mode:observe")).toBe("probe/observe run");
  });

  it("FAIL CLOSED: a reached row naming no dispatcher (goal-host's sync /resolve walk) is skipped", () => {
    // exec_m1qff70w, a /resolve walk that reused the extracted SVG template, carried no tags.
    expect(ruleFor(undefined)).toBe("dispatcher_used:absent");
    expect(ruleFor(["state_signature:4cdd6171", "reach_graded:true", "reached:true"])).toBe("dispatcher_used:absent");
    expect(eligibility.skipTagReason?.("dispatcher_used:absent")).toContain("fail closed");
  });

  it("CONTROL: a reached multi-task trace from another dispatcher is still extracted", () => {
    expect(trivialTaskCountSkip(3, fallback)).toBeNull();
    expect(ruleFor(["dispatcher_used:light-dispatch", "operator:boredom", "reached:true"])).toBeNull();
    // Exact match: a tag merely naming goal-host is not the goal-host dispatcher tag.
    expect(ruleFor(["dispatcher_used:light-dispatch", "operator:goal-host-behavior", "goal:dispatcher_used:goal-host-x"])).toBeNull();
  });

  it("CONTROL: probe / observe skips keep their rule", () => {
    expect(skipTagRule(["probe:trend-expectation-check", "dispatcher_used:goal-host"], fallback)).toBe("probe:*");
    expect(skipTagRule(["learning_mode:observe", "dispatcher_used:light-dispatch"], fallback)).toBe("learning_mode:observe");
  });

  it("a policy that sets skipTags replaces the list, goal-host tag included (law 1)", () => {
    const r = skipRulesFromPolicy({ skipTags: ["operator:smoke"] });
    expect(skipTagRule(grb13zc4, r)).toBeNull();
  });
});
