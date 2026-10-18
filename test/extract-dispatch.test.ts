import { describe, it, expect } from "bun:test";
// Through the test loader: index.ts binds the vessel port on import (see vessel-module.ts).
import { vessel } from "./vessel-module";

// goal-host's write door runs a store write on a dispatch not admitted as a change only as
// the dispatch's own product. ribosome-extract's task 5 writes activityTemplate_write, and the
// extraction dispatch declared no product, so since the door landed that task was skipped on
// every run and the ribosome persisted nothing. It must still send no goal text: a goal routes
// the pinned run's grading to goal-host's goal-reach gate and LLM judge instead of the
// declarative check against the template's output_shapes.
type Body = {
  goal?: unknown;
  expected_output_shapes?: unknown;
  targetTemplateId?: unknown;
  variables?: Record<string, unknown>;
  tags?: unknown;
};
const build = (vessel as { ribosomeExtractBody?: (id: string, lifecycle?: unknown) => Body }).ribosomeExtractBody;
const ID = "auth_1792359670167_mod9owd";
const LIFECYCLE = { executionId: ID, status: "completed", taskCount: 4, qualityEligible: true };

describe("ribosome-extract dispatch body", () => {
  it("must-fail: declares the template write as its product, and sends no goal", () => {
    expect(typeof build).toBe("function");
    const body = build!(ID, LIFECYCLE);
    expect(body.expected_output_shapes).toEqual(["activityTemplate_write"]);
    expect("goal" in body).toBe(false);
    expect("goal" in build!(ID)).toBe(false);
  });

  it("control: the existing dispatch fields are unchanged", () => {
    expect(typeof build).toBe("function");
    const body = build!(ID, LIFECYCLE);
    expect(body.targetTemplateId).toBe("ribosome-extract");
    expect(body.variables).toEqual({ executionId: ID, applyExtraction: true, lifecycle: LIFECYCLE });
    expect(body.tags).toEqual(["ribosome-vessel-dispatch"]);
    const bare = build!(ID);
    expect(bare.variables).toEqual({ executionId: ID, applyExtraction: true });
    expect("lifecycle" in (bare.variables ?? {})).toBe(false);
  });
});
