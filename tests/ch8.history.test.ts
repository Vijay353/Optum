/** V3 CH-8: trailing history with the source clinic, from this system's own records. */
import { afterEach, describe, expect, it } from "vitest";
import { api, countRows, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";
import { ManualClock } from "../src/domain/clock";
import { sourceHistory } from "../src/persistence/sourceHistory";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

const LAKE = "SYN-ORG-PT-301";
const check = async (e: TestEnv, draft: string) => (await api<{ run: Run }>(e, "POST", `/api/drafts/${draft}/check`)).body.run;
type Ws = { sourceHistory: null | Record<string, number | string | null> };

describe("source history", () => {
  it("counts one per draft by its latest check, excludes the current draft and other clinics", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    expect((await api<Ws>(env, "GET", "/api/workspace")).body.sourceHistory).toBeNull(); // no run yet
    await check(env, "PA-DRAFT-99415"); // Lakeside, ambiguous match → manual review
    await check(env, "PA-DRAFT-99415"); // checked twice, still one draft
    const inj = await check(env, "PA-DRAFT-99418"); // Lakeside, evaluated
    await check(env, "PA-DRAFT-99413"); // Riverbend: another clinic
    await check(env, "PA-DRAFT-99419"); // superseded policy: stops before claims, no clinic
    await check(env, "PA-DRAFT-99412"); // current draft
    let h = (await api<Ws>(env, "GET", "/api/workspace")).body.sourceHistory!;
    expect(h).toMatchObject({ sourceOrgId: LAKE, windowDays: 90, excludedDraftId: "PA-DRAFT-99412", draftsChecked: 2, manualReview: 1, waitingForStaging: 1, taskCreated: 0, noTaskOther: 0 });
    await api(env, "POST", `/api/runs/${inj.runId}/stage`);
    h = (await api<Ws>(env, "GET", "/api/workspace")).body.sourceHistory!;
    expect(h).toMatchObject({ draftsChecked: 2, taskCreated: 1, manualReview: 1, waitingForStaging: 0 });
    const sum = (h.taskCreated as number) + (h.manualReview as number) + (h.waitingForStaging as number) + (h.noTaskOther as number);
    expect(sum).toBe(h.draftsChecked);
  });

  it("window edges are inclusive at exactly 90 days and exclude anything older", async () => {
    const clock = new ManualClock("2026-10-18T13:10:00Z");
    env = await startTestServer({ scenario: "primary-success", clock });
    await check(env, "PA-DRAFT-99415");
    const t0 = clock.now().getTime();
    expect(sourceHistory(env.db, { sourceOrgId: LAKE, now: new Date(t0 + 90 * 86_400_000) }).draftsChecked).toBe(1);
    expect(sourceHistory(env.db, { sourceOrgId: LAKE, now: new Date(t0 + 90 * 86_400_000 + 1) }).draftsChecked).toBe(0);
    expect(sourceHistory(env.db, { sourceOrgId: LAKE, now: new Date(t0 - 1) }).draftsChecked).toBe(0); // future runs never count
  });

  it("reading history writes nothing and an empty window says no history", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    await check(env, "PA-DRAFT-99412");
    const before = countRows(env.db, "app_runs") + countRows(env.db, "app_audit");
    const h = (await api<Ws>(env, "GET", "/api/workspace")).body.sourceHistory!;
    expect(h.draftsChecked).toBe(0);
    expect(countRows(env.db, "app_runs") + countRows(env.db, "app_audit")).toBe(before);
  });
});
