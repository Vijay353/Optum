/**
 * Product P9: metrics are aggregates of real run records only; the estimate
 * is a visible formula over an observed count; the snapshot says only true,
 * computed things and labels the estimate (invariant I-1.3.4).
 */
import { afterEach, describe, expect, it } from "vitest";
import { api, countRows, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";
import { computeMetrics, type Metrics } from "../src/server/metrics";
import { DEFAULT_MINUTES_PER_CHASE, decisionBars, readbackRate, snapshotText, staffTimeEstimate } from "../src/ui/metricsText";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });
const metrics = async () => (await api<{ metrics: Metrics; source: string }>(env!, "GET", "/api/metrics")).body;

describe("GET /api/metrics", () => {
  it("is all zeros on an empty run table and writes nothing", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const m = await metrics();
    expect(m.source).toBe("app_runs");
    expect(m.metrics).toMatchObject({ checksRun: 0, draftsChecked: 0, evidenceFoundDrafts: 0, tasksStaged: 0, readback: { attempted: 0, verified: 0 }, writesRefused: 0, firstCheckAt: null });
    expect(countRows(env.db, "app_runs")).toBe(0);
    expect(readbackRate(m.metrics)).toBeNull();
  });

  it("after one check reflects exactly one run; after staging, one verified task", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const run = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    let m = (await metrics()).metrics;
    expect(m).toMatchObject({ checksRun: 1, draftsChecked: 1, evidenceFoundDrafts: 1, awaitingStaging: 1, tasksStaged: 0, latestDecisions: { REVIEW_EXTERNAL_EVIDENCE: 1 } });
    const staged = (await api<{ run: Run }>(env, "POST", `/api/runs/${run.runId}/stage`)).body.run;
    m = (await metrics()).metrics;
    expect(m).toMatchObject({ checksRun: 1, tasksStaged: 1, awaitingStaging: 0, readback: { attempted: 1, verified: 1 } });
    expect(readbackRate(m)).toBe(100);
    expect(m.avgTraceSteps.REVIEW_EXTERNAL_EVIDENCE).toBe(staged.trace.length);
  });

  it("counts a replayed task once and a refused write as refused", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const r1 = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    await api(env, "POST", `/api/runs/${r1.runId}/stage`);
    const r2 = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run; // redelivery of the same event
    await api(env, "POST", `/api/runs/${r2.runId}/stage`);
    const m = (await metrics()).metrics;
    expect(m.checksRun).toBe(2);
    expect(m.tasksStaged).toBe(1);
    expect(countRows(env.db, "ehr_tasks")).toBe(1);

    await env.close();
    env = await startTestServer({ scenario: "primary-success" });
    const r3 = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    await api(env, "POST", "/api/drafts/PA-DRAFT-99412/simulate-edit");
    await api(env, "POST", `/api/runs/${r3.runId}/stage`);
    expect((await metrics()).metrics.writesRefused).toBe(1);
  });
});

describe("estimate and snapshot (pure)", () => {
  const base = computeMetrics([]);
  const m: Metrics = { ...base, checksRun: 9, draftsChecked: 8, evidenceFoundDrafts: 2, tasksStaged: 1, readback: { attempted: 1, verified: 1 }, latestDecisions: { REVIEW_EXTERNAL_EVIDENCE: 2, ACCESS_NOT_PERMITTED: 2, MANUAL_REVIEW: 3, CLAIM_LEAD_ONLY: 1 } };
  it("estimate = observed drafts with evidence × assumed minutes, formula shown", () => {
    const e = staffTimeEstimate(m, 35);
    expect(e).toMatchObject({ draftsWithEvidence: 2, minutesPerChase: 35, minutesSaved: 70, hoursSaved: 1.2 });
    expect(e.formula).toBe("2 drafts with outside evidence found × 35 min per manual records chase = 70 min");
    expect(staffTimeEstimate(m, Number.NaN).minutesPerChase).toBe(DEFAULT_MINUTES_PER_CHASE);
    expect(staffTimeEstimate(m, 10_000).minutesPerChase).toBe(600);
  });
  it("decision bars are sorted and labelled in words", () => {
    expect(decisionBars(m).map((b) => [b.label, b.value, b.widthPct])).toEqual([["Needs a person", 3, 100], ["Not allowed to look", 2, 67], ["Evidence found", 2, 67], ["Billing records only", 1, 33]]);
  });
  it("snapshot contains only computed values, labels the estimate and carries the honesty footer", () => {
    const t = snapshotText(m, "2026-10-18T13:10:00.000Z", 35);
    expect(t).toContain("Drafts checked before submission: 8 (9 checks in total)");
    expect(t).toContain("Review tasks created and verified: 1");
    expect(t).toContain("Read-back verification: 1 of 1 (100%)");
    expect(t).toMatch(/ESTIMATE, not observed: .*about 1\.2 h\)/);
    expect(t).toContain("Conceptual prototype, simulated data, demo identity. Not an official Optum product.");
    // Every number in the text is either a computed value, the assumption, or part of the date.
    const allowed = new Set(["8", "9", "1", "100", "2", "3", "0", "35", "70", "1.2", "2026", "10", "18", "13", "00.000"]);
    for (const n of t.match(/\d+(?:\.\d+)?/g) ?? []) expect(allowed.has(n), n).toBe(true);
  });
});
