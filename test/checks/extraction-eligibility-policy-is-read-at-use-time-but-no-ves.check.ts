import { test, expect } from "bun:test";
import * as eligibility from "../../src/extraction-eligibility";

test("extractionEligibilityPolicy provides skip rules, not fallbacks", () => {
  // The defect is that no vessel serves the `extractionEligibilityPolicy` impulse.
  // In `ribosome-vessel`, this results in `resolveShapedPolicy` returning null.
  // We simulate this condition by passing `null` to `skipRulesFromPolicy`.
  const rules = eligibility.skipRulesFromPolicy(null);

  // The assertion will fail because `rules.fallbacks` will contain three entries
  // ("minTaskCount", "skipTags", "skipTagPrefixes"), not an empty array. This failing
  // test demonstrates that the fallback logic is being used due to the
  // missing policy.
  expect(rules.fallbacks).toEqual([]);
});
