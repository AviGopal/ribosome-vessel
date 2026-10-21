import { expect, test } from "bun:test";
import * as mod from "../../src/replay-observer.js";

// Repro: buildRelevancePayload currently sets execution_succeeded based on
// judgement.score >= 0.5. Historical replays only consider SUCCESSFUL traces,
// so a low judge score (<0.5) on a successful trace records a failure, which
// drives near-zero relevance rows. This test encodes the expected behavior —
// successful traces should be marked as succeeded — and therefore FAILS with
// the current implementation.

test("replay payload marks successful trace as succeeded even when judge score < 0.5", () => {
  const template: mod.TemplateCreatedEventData = {
    template_id: "tmpl-123",
    input_shapes: ["shape.A"],
  };
  const trace: mod.HistoricalTrace = {
    execution_id: "exec-456",
    success: true,
    input_impulse_shapes: ["shape.A"],
    executed_at: new Date().toISOString(),
  };
  const judgement: mod.ReplayJudgement = {
    score: 0.0, // low judge score observed in production
    confidence: 0.9,
  };

  // Sanity: the trace matches the template's inputs and would be selected.
  expect(mod.tracesMatchShapes(trace, ["shape.A"])).toBe(true);
  expect(mod.selectReplayTraces([trace], ["shape.A"], 3)).toHaveLength(1);

  const payload = mod.buildRelevancePayload(template, trace, judgement, 0.3);

  // payload echoes ids correctly
  expect((payload as any).activity_variant_id).toBe("tmpl-123");
  expect((payload as any).replay_trace_id).toBe("exec-456");

  // EXPECTED (desired) behavior: successful historical trace should record success,
  // regardless of low replay judge score. This assertion FAILS today because
  // execution_succeeded is computed as (judgement.score >= 0.5).
  expect((payload as any).execution_succeeded).toBe(true);
});
