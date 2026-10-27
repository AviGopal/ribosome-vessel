import { test, expect } from "bun:test";
import * as replayObserver from "../../src/replay-observer";

test("runReplayJob > aborts on first malformed judge response (failing replica of dev red)", async () => {
  const template = {
    template_id: "test-template",
    name: "Test Template",
    input_shapes: [],
    output_shapes: [],
    tasks: [],
  };

  const traces = [
    {
      execution_id: "trace-1",
      activity_id: "act-1",
      input_impulse_shapes: [],
      output_impulse_shapes: [],
      success: true,
      duration_ms: 100,
      executed_at: new Date().toISOString(),
    },
  ];

  // Mock deps
  const deps = {
    readTraces: async () => traces,
    writeRelevance: async () => {},
    fetchLlmCompletion: async () => ({ text: "malformed json" }),
  };

  const result = await replayObserver.runReplayJob(template, [], deps);

  // This assertion fails because the original runReplayJob, on malformed_judgement, returns
  // { attempted: 1, written: 0, aborted: true, reason: "malformed_judgement" }
  // and the fix should make it return { attempted: 1, written: 0, aborted: true, reason: "malformed_judgement" }
  // This test expects what the fix makes it return.
  expect(result).toEqual({
    attempted: 1,
    written: 0,
    aborted: true,
    reason: "malformed_judgement",
  });
});

test("The new replay-relevance-credits-the-judge test stays green (control)", async () => {
  const template = {
    template_id: "control-template",
    name: "Control Template",
    input_shapes: ["shape-A"],
    output_shapes: ["shape-B"],
    tasks: [],
  };

  const traces = [
    {
      execution_id: "control-trace-1",
      activity_id: "control-act-1",
      input_impulse_shapes: ["shape-A"],
      output_impulse_shapes: ["shape-B"],
      success: true,
      duration_ms: 200,
      executed_at: new Date().toISOString(),
    },
  ];

  // Mock deps
  const deps = {
    readTraces: async () => traces,
    writeRelevance: async () => {},
    fetchLlmCompletion: async () => (
      { text: '{"score": 0.9, "confidence": 0.8, "divergent_task": ""}' }
    ),
  };

  const result = await replayObserver.runReplayJob(template, ["shape-A"], deps);

  expect(result).toEqual({
    attempted: 1,
    written: 1,
    aborted: false,
  });
});
