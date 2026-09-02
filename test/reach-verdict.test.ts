import { describe, it, expect } from "bun:test";
import { reachVerdictFromTraceRow } from "../src/index";

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

  it("prefers the column over a disagreeing tag — EXCEPT when the column is the LOSSY direction", () => {
    // column=true vs tag=false: the column wins. The patch that set it ran AFTER the
    // insert, so it is the later information, and it is the SAFE direction — it can only
    // grant a reach the walk already claimed.
    expect(reachVerdictFromTraceRow({ reached: true, tags: ["reached:false"] }).verdict).toBe("reached");
  });

  it("RESOLVES column=false + tag=reached:true TO REACHED — reversal of my own 2026-09-02 rule", () => {
    // I wrote the original rule this morning as "the column is the verdict of record; if
    // they disagree the column wins". MEASUREMENT REFUTED IT the same day.
    //
    // walk-satisfier-1-1788364637686 — the goal "count the .ts files under
    // repos/ribosome-vessel/src", whose answer (7) I verified INDEPENDENTLY with a host-side
    // recount — carries, right now, in the live store:
    //
    //     status = success     tags = ["reached:true"]     reached = False
    //
    // The row contradicts itself. `reached:true` is written by goal-host's GRADE-AT-INSERT
    // path, locally and synchronously, from the walk's own verdict. The column is derived at
    // ingest and can be written before that verdict exists (measured patch lag runs to 586s).
    // So on this disagreement the TAG is the later, better-informed value, and the previous
    // rule made the ribosome discard a genuinely reached execution — starving the very
    // extraction it exists to perform. That is the opposite of what my morning change was for.
    //
    // This CANNOT manufacture a false reach: the tag carries the same verdict the patch would
    // have written. It is deliberately ONE-DIRECTIONAL — only the lossy direction is
    // overridden — and the `why` names the contradiction so the write-side defect stays
    // visible instead of being papered over here.
    const d = reachVerdictFromTraceRow({ reached: false, tags: ["reached:true"] });
    expect(d.verdict).toBe("reached");
    expect(d.why).toContain("contradiction");
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
