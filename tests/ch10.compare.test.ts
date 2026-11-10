/** V3 CH-10: honest proportional comparison of billed lines and documented visits. */
import { afterEach, describe, expect, it } from "vitest";
import { api, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";
import { compareCounts, comparisonSentence } from "../src/ui/compare";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

describe("compareCounts", () => {
  it("equal counts", () => {
    expect(compareCounts(12, 12)).toEqual({ billed: { value: 12, widthPct: 100 }, documented: { value: 12, widthPct: 100 }, relation: "EQUAL", difference: 0 });
    expect(comparisonSentence(compareCounts(12, 12)!)).toMatch(/does not prove/);
  });
  it("shortage and overage are not clipped", () => {
    expect(compareCounts(12, 10)).toMatchObject({ billed: { widthPct: 100 }, documented: { widthPct: 83.3 }, relation: "FEWER_DOCUMENTED", difference: 2 });
    expect(compareCounts(10, 12)).toMatchObject({ billed: { widthPct: 83.3 }, documented: { widthPct: 100 }, relation: "MORE_DOCUMENTED", difference: 2 });
    expect(comparisonSentence(compareCounts(12, 11)!)).toBe("The summary documents 1 fewer visit than the claims bill. A person should check why.");
  });
  it("zero, single and large values", () => {
    expect(compareCounts(0, 0)).toMatchObject({ billed: { widthPct: 0 }, documented: { widthPct: 0 }, relation: "EQUAL" });
    expect(compareCounts(1, 0)).toMatchObject({ documented: { widthPct: 0 }, relation: "FEWER_DOCUMENTED" });
    expect(compareCounts(100000, 1)).toMatchObject({ billed: { widthPct: 100 }, documented: { widthPct: 0 } });
  });
  it("no bar when the documented count is unknown or invalid", () => {
    expect(compareCounts(12, null)).toBeNull();
    expect(compareCounts(12, 2.5)).toBeNull();
    expect(compareCounts(-1, 3)).toBeNull();
  });
  it("seeded data: equal in the primary case, two fewer in the amended-copy case", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const visitsOf = (r: Run) => r.extraction?.output?.facts.find((f) => f.field === "documented_visit_count")?.normalizedValue as number;
    let r = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    expect(compareCounts(r.claims!.leadCount, visitsOf(r))?.relation).toBe("EQUAL");
    await env.close();
    env = await startTestServer({ scenario: "possible-duplicate-document" });
    r = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    expect(compareCounts(r.claims!.leadCount, visitsOf(r))).toMatchObject({ relation: "FEWER_DOCUMENTED", difference: 2 });
  });
});
