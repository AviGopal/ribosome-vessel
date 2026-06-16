/**
 * Tests for the TemplateReplayObserver pure-logic surface.
 * Network I/O is verified by injecting a fetch mock into runReplayJob.
 *
 * Run: bun test (from repos/ribosome-vessel/)
 */

import { describe, expect, it } from "bun:test";
import {
  buildRelevancePayload,
  buildReplayPrompt,
  parseReplayJudgement,
  parseTemplateCreatedEvent,
  runReplayJob,
  selectReplayTraces,
  tracesMatchShapes,
  type HistoricalTrace,
  type ReplayObserverDeps,
} from "../src/replay-observer";

describe("parseTemplateCreatedEvent", () => {
  it("returns null for non-template_created messages", () => {
    expect(parseTemplateCreatedEvent(null)).toBeNull();
    expect(parseTemplateCreatedEvent({ type: "task.completed" })).toBeNull();
    expect(parseTemplateCreatedEvent({ type: "template_created" })).toBeNull();
  });

  it("extracts template_id and input_shapes from a valid event", () => {
    const parsed = parseTemplateCreatedEvent({
      type: "template_created",
      data: {
        template_id: "act_abc",
        input_shapes: ["goal", "concept"],
        output_shapes: ["activityTemplate"],
        tasks: [{ id: "t1" }],
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.templateId).toBe("act_abc");
    expect(parsed!.inputShapes).toEqual(["goal", "concept"]);
  });

  it("falls back to activity_id when template_id is missing", () => {
    const parsed = parseTemplateCreatedEvent({
      type: "template_created",
      data: { activity_id: "act_legacy", input_shapes: [] },
    });
    expect(parsed?.templateId).toBe("act_legacy");
    expect(parsed?.inputShapes).toEqual([]);
  });

  it("filters non-string entries from input_shapes", () => {
    const parsed = parseTemplateCreatedEvent({
      type: "template_created",
      data: { template_id: "x", input_shapes: ["a", 42, null, "b"] },
    });
    expect(parsed?.inputShapes).toEqual(["a", "b"]);
  });
});

describe("tracesMatchShapes", () => {
  const trace: HistoricalTrace = {
    execution_id: "exec_1",
    input_impulse_shapes: ["a", "b", "c"],
  };

  it("matches when needed is empty", () => {
    expect(tracesMatchShapes(trace, [])).toBe(true);
  });

  it("matches when needed is a subset of have", () => {
    expect(tracesMatchShapes(trace, ["a", "b"])).toBe(true);
    expect(tracesMatchShapes(trace, ["c"])).toBe(true);
  });

  it("rejects when any needed shape is missing", () => {
    expect(tracesMatchShapes(trace, ["a", "z"])).toBe(false);
  });

  it("handles trace without input_impulse_shapes", () => {
    expect(tracesMatchShapes({ execution_id: "e" } as HistoricalTrace, ["a"])).toBe(false);
    expect(tracesMatchShapes({ execution_id: "e" } as HistoricalTrace, [])).toBe(true);
  });
});

describe("selectReplayTraces", () => {
  const traces: HistoricalTrace[] = [
    { execution_id: "e1", input_impulse_shapes: ["a", "b"] },
    { execution_id: "e2", input_impulse_shapes: ["a"] },
    { execution_id: "e3", input_impulse_shapes: ["a", "b", "c"] },
    { execution_id: "e4", input_impulse_shapes: ["a", "b"] },
    { execution_id: "e5", input_impulse_shapes: ["x"] },
  ];

  it("filters and caps", () => {
    const out = selectReplayTraces(traces, ["a", "b"], 3);
    expect(out.map((t) => t.execution_id)).toEqual(["e1", "e3", "e4"]);
  });

  it("caps to fewer than matching when cap is smaller", () => {
    expect(selectReplayTraces(traces, ["a"], 2).length).toBe(2);
  });
});

describe("parseReplayJudgement", () => {
  it("parses a clean JSON response", () => {
    const j = parseReplayJudgement('{"score":0.8,"confidence":0.6}');
    expect(j?.score).toBe(0.8);
    expect(j?.confidence).toBe(0.6);
  });

  it("parses with divergent_task", () => {
    const j = parseReplayJudgement(
      '{"score":0.3,"confidence":0.9,"divergent_task":"t2"}',
    );
    expect(j?.divergent_task).toBe("t2");
  });

  it("strips prose around the JSON", () => {
    const j = parseReplayJudgement(
      'Here is my judgement:\n```json\n{"score":0.5,"confidence":0.5}\n```\nDone.',
    );
    expect(j?.score).toBe(0.5);
  });

  it("returns null for malformed JSON", () => {
    expect(parseReplayJudgement("")).toBeNull();
    expect(parseReplayJudgement("not json")).toBeNull();
    expect(parseReplayJudgement('{"score":"high"}')).toBeNull();
  });

  it("returns null for out-of-range scores", () => {
    expect(parseReplayJudgement('{"score":1.5,"confidence":0.5}')).toBeNull();
    expect(parseReplayJudgement('{"score":-0.1,"confidence":0.5}')).toBeNull();
  });
});

describe("buildReplayPrompt", () => {
  it("includes template id, shapes, and trace outcome", () => {
    const p = buildReplayPrompt(
      {
        template_id: "tpl_x",
        name: "do-thing",
        input_shapes: ["a"],
        output_shapes: ["b"],
        tasks: [{ id: "t1", resolver: "llm" }],
      },
      {
        execution_id: "exec_42",
        input_impulse_shapes: ["a", "extra"],
        output_impulse_shapes: ["b"],
        success: true,
      },
    );
    expect(p).toContain("tpl_x");
    expect(p).toContain("exec_42");
    expect(p).toContain("success");
    expect(p).toContain("score");
  });
});

describe("buildRelevancePayload", () => {
  it("threads source/replay_trace_id/replay_weight", () => {
    const payload = buildRelevancePayload(
      { template_id: "tpl_x", input_shapes: ["a"] },
      { execution_id: "exec_1", input_impulse_shapes: ["a"] },
      { score: 0.7, confidence: 0.8 },
      0.3,
    );
    expect(payload.activity_variant_id).toBe("tpl_x");
    expect(payload.source).toBe("background_replay");
    expect(payload.replay_trace_id).toBe("exec_1");
    expect(payload.replay_weight).toBe(0.3);
    expect(payload.execution_succeeded).toBe(true);
  });

  it("marks execution_succeeded false when score < 0.5", () => {
    const payload = buildRelevancePayload(
      { template_id: "tpl_x" },
      { execution_id: "exec_1", input_impulse_shapes: ["a"] },
      { score: 0.4, confidence: 0.5 },
      0.3,
    );
    expect(payload.execution_succeeded).toBe(false);
  });
});

describe("runReplayJob (with mocked fetch)", () => {
  function makeFetch(
    responders: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>,
  ): typeof fetch {
    let i = 0;
    return (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      const responder = responders[Math.min(i, responders.length - 1)];
      i++;
      return responder(url, init);
    }) as unknown as typeof fetch;
  }

  const baseDeps = (fetchImpl: typeof fetch): ReplayObserverDeps => ({
    activityApiEndpoint: "http://activity-api",
    apiKey: "test-key",
    llmEndpoint: "http://llm",
    fetchImpl,
  });

  it("returns no_matches when no shape-compatible traces exist", async () => {
    const f = makeFetch([
      () =>
        new Response(
          JSON.stringify({
            executions: [
              { execution_id: "e1", input_impulse_shapes: ["unrelated"] },
            ],
          }),
          { status: 200 },
        ),
    ]);
    const res = await runReplayJob(
      { template_id: "tpl", input_shapes: ["needed"] },
      ["needed"],
      baseDeps(f),
    );
    expect(res.reason).toBe("no_matches");
    expect(res.written).toBe(0);
  });

  it("writes a relevance row for a clean judge response", async () => {
    const f = makeFetch([
      // 1. fetch traces
      () =>
        new Response(
          JSON.stringify({
            executions: [
              {
                execution_id: "exec_1",
                input_impulse_shapes: ["needed"],
                output_impulse_shapes: ["out"],
                success: true,
              },
            ],
          }),
          { status: 200 },
        ),
      // 2. llm judge
      () =>
        new Response(
          JSON.stringify({
            resolved: true,
            content: '{"score":0.8,"confidence":0.7}',
          }),
          { status: 200 },
        ),
      // 3. relevance write
      () => new Response(JSON.stringify({ success: true }), { status: 200 }),
    ]);
    const res = await runReplayJob(
      { template_id: "tpl", input_shapes: ["needed"] },
      ["needed"],
      baseDeps(f),
    );
    expect(res.attempted).toBe(1);
    expect(res.written).toBe(1);
    expect(res.aborted).toBe(false);
  });

  it("aborts on first malformed judge response", async () => {
    const f = makeFetch([
      () =>
        new Response(
          JSON.stringify({
            executions: [
              { execution_id: "e1", input_impulse_shapes: ["needed"] },
              { execution_id: "e2", input_impulse_shapes: ["needed"] },
            ],
          }),
          { status: 200 },
        ),
      () =>
        new Response(
          JSON.stringify({ resolved: true, content: "not json at all" }),
          { status: 200 },
        ),
    ]);
    const res = await runReplayJob(
      { template_id: "tpl", input_shapes: ["needed"] },
      ["needed"],
      baseDeps(f),
    );
    expect(res.aborted).toBe(true);
    expect(res.reason).toBe("malformed_judgement");
    expect(res.written).toBe(0);
  });
});
