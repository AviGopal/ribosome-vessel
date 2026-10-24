// A re-judged replay credits relevance by the judge's score, not by the
// trace's exit status. Every trace the replay re-judges already exited
// successfully, so letting trace.success decide execution_succeeded would
// make replay relevance follow exit status and drop the judge's signal.
import { describe, expect, it } from "bun:test";
import { buildRelevancePayload } from "../src/replay-observer.js";

describe("buildRelevancePayload credits a re-judged success by the judge", () => {
  it("records execution_succeeded false for a successful trace the judge scores below 0.5", () => {
    const payload = buildRelevancePayload(
      { template_id: "tpl_x", input_shapes: ["a"] },
      { execution_id: "exec_1", success: true, input_impulse_shapes: ["a"] },
      { score: 0.0, confidence: 0.9 },
      0.3,
    );
    expect(payload.execution_succeeded).toBe(false);
  });

  it("control: records execution_succeeded true for a successful trace the judge scores at or above 0.5", () => {
    const payload = buildRelevancePayload(
      { template_id: "tpl_x", input_shapes: ["a"] },
      { execution_id: "exec_1", success: true, input_impulse_shapes: ["a"] },
      { score: 0.5, confidence: 0.9 },
      0.3,
    );
    expect(payload.execution_succeeded).toBe(true);
  });
});
