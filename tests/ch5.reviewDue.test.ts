/**
 * V3 CH-5 (refined): an overdue review Task is flagged on read from its own due
 * time and the scenario clock. Nothing is written and no authority widens.
 */
import { afterEach, describe, expect, it } from "vitest";
import { api, countRows, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";
import { DUE_SOON_HOURS, reviewDue } from "../src/domain/reviewDue";
import { ManualClock } from "../src/domain/clock";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });
const H = 3600_000;
const due = "2026-10-20T13:10:00.000Z";

describe("reviewDue boundaries", () => {
  it("before, at and after the due time", () => {
    expect(reviewDue(due, new Date(Date.parse(due) - DUE_SOON_HOURS * H - 1))).toMatchObject({ state: "ON_TIME", hoursLeft: 12 });
    expect(reviewDue(due, new Date(Date.parse(due) - DUE_SOON_HOURS * H))).toMatchObject({ state: "DUE_SOON" });
    expect(reviewDue(due, new Date(Date.parse(due) - 1))).toMatchObject({ state: "DUE_SOON", hoursLeft: 0, hoursOverdue: 0 });
    expect(reviewDue(due, new Date(due))).toMatchObject({ state: "OVERDUE", hoursOverdue: 0 });
    expect(reviewDue(due, new Date(Date.parse(due) + 25 * H))).toMatchObject({ state: "OVERDUE", hoursOverdue: 25 });
    expect(() => reviewDue("not a date", new Date())).toThrow(RangeError);
  });
});

type Ws = { taskDue: Array<{ taskId: string; state: string; hoursOverdue: number; owner: string }> };

describe("workspace due state", () => {
  it("is derived on read from the scenario clock, with no writes and no authority change", async () => {
    const clock = new ManualClock("2026-10-18T13:10:00Z");
    env = await startTestServer({ scenario: "primary-success", clock });
    const c = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    await api(env, "POST", `/api/runs/${c.runId}/stage`);
    const read = async (role = "pa-specialist") => (await api<Ws>(env!, "GET", "/api/workspace", undefined, role)).body.taskDue;
    expect(await read()).toEqual([expect.objectContaining({ taskId: "TASK-EVID-1042", state: "ON_TIME", owner: "CareTeam/pa-specialist-queue" })]);
    clock.advance(36 * H + 1);
    expect((await read())[0]?.state).toBe("DUE_SOON");
    clock.set("2026-10-20T13:10:00Z");
    expect((await read())[0]?.state).toBe("OVERDUE");
    clock.advance(25 * H);
    const writesBefore = { tasks: countRows(env.db, "ehr_tasks"), ehr: countRows(env.db, "ehr_audit"), app: countRows(env.db, "app_audit"), runs: countRows(env.db, "app_runs") };
    for (let i = 0; i < 3; i++) expect((await read("viewer"))[0]).toMatchObject({ state: "OVERDUE", hoursOverdue: 25 });
    expect({ tasks: countRows(env.db, "ehr_tasks"), ehr: countRows(env.db, "ehr_audit"), app: countRows(env.db, "app_audit"), runs: countRows(env.db, "app_runs") }).toEqual(writesBefore);
    // Overdue does not let a viewer stage anything.
    const c2 = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99413/check")).body.run;
    expect((await api(env, "POST", `/api/runs/${c2.runId}/stage`, undefined, "viewer")).status).toBe(403);
  });

  it("no task means no due entries", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    expect((await api<Ws>(env, "GET", "/api/workspace")).body.taskDue).toEqual([]);
  });
});
