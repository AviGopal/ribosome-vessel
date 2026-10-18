import { describe, it, expect } from "bun:test";
// Through the test loader, not a static import of ../src/index: index.ts binds the vessel port
// on import, which collides with the live vessel wherever the gate runs (see vessel-module.ts).
import { vessel } from "./vessel-module";

const { reachVerdictFromTraceRow } = vessel;

// The ribosome extracts templates FROM REACHED EXECUTIONS (law 4). It could not see
// which executions reached: `reached` is an option<bool> column on `execution`, but the
// compat view did not project it until 2026-09-02, so the trace endpoint returned no
// such field and this vessel string-matched a `reached:*` tag instead.
//
// Tags are caller-written and incomplete. From this vessel's own measurements: of 700
// hub rows, 540 were validator-dispatch / slot-binding and ZERO carried a reached:* tag;
// the re-read loop scored 18 reached per 1476 re-reads (1.22%) against a fleet whose
// honest reach is ~13%. The extraction organ was starved by a read-path gap, not by a
// shortage of reached executions.
describe("reachVerdictFromTraceRow", () => {
  it("reads the COLUMN as authoritative when present", () => {
    expect(reachVerdictFromTraceRow({ reached: true })).toEqual({ verdict: "reached", why: "column:reached=true" });
    expect(reachVerdictFromTraceRow({ reached: false })).toEqual({ verdict: "not-reached", why: "column:reached=false" });
  });

  it("prefers the column OVER a disagreeing tag", () => {
    // Tags are written by callers and by the patch path; the column is the verdict of
    // record. If they disagree the column wins, or this fix changes nothing.
    expect(reachVerdictFromTraceRow({ reached: true, tags: ["reached:false"] }).verdict).toBe("reached");
    expect(reachVerdictFromTraceRow({ reached: false, tags: ["reached:true"] }).verdict).toBe("not-reached");
  });

  it("NEVER reads null as not-reached — the load-bearing case", () => {
    // null means NEVER GRADED. Marking it not-reached would brand every ungraded row a
    // failure and would be a worse version of the bug this replaces.
    const d = reachVerdictFromTraceRow({ reached: null, tags: [] });
    expect(d.verdict).toBeNull();
    expect(d.why).toBe("column-null-ungraded");
    expect(reachVerdictFromTraceRow({ reached: undefined }).verdict).toBeNull();
  });

  it("falls back to tags when the column is absent — rolling-deploy safety", () => {
    // An activity-api predating the projection fix returns no `reached` key. Dropping
    // the tag path would blind this vessel against an older peer mid-deploy.
    expect(reachVerdictFromTraceRow({ tags: ["reached:true"] })).toEqual({ verdict: "reached", why: "tag:reached:true" });
    expect(reachVerdictFromTraceRow({ tags: ["reached:false"] })).toEqual({ verdict: "not-reached", why: "tag:reached:false" });
  });

  it("distinguishes ungraded from untagged in the reason, so the journal can tell them apart", () => {
    expect(reachVerdictFromTraceRow({ tags: ["other:x"] }).why).toBe("no-reach-tag");
    expect(reachVerdictFromTraceRow({}).why).toBe("no-tags");
    expect(reachVerdictFromTraceRow({ reached: null }).why).toBe("column-null-ungraded");
  });

  it("is safe on malformed input", () => {
    for (const bad of [{ reached: "true" }, { reached: 1 }, { tags: "reached:true" }, { tags: null }]) {
      expect(reachVerdictFromTraceRow(bad as never).verdict).toBeNull();
    }
  });
});
