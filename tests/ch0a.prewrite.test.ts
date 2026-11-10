/**
 * CH-0A: consent, attribution and evaluation age are checked again immediately
 * before the one write. Any failure stops before the tool is called.
 */
import { afterEach, describe, expect, it } from "vitest";
import { api, countRows, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";
import { setFault } from "../src/simulators/shared";
import { loadConfig } from "../src/server/config";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

const check = async (e: TestEnv) => (await api<{ run: Run }>(e, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
const stage = async (e: TestEnv, runId: string) => (await api<{ run: Run }>(e, "POST", `/api/runs/${runId}/stage`)).body.run;
const draftStatus = (e: TestEnv) => (e.db.prepare("SELECT business_status FROM ehr_prior_auth_drafts WHERE id = 'PA-DRAFT-99412'").get() as { business_status: string }).business_status;

/** Moves a stored run's evaluation time into the past (test setup only). */
function ageRun(e: TestEnv, runId: string, minutes: number) {
  const row = e.db.prepare("SELECT run_json FROM app_runs WHERE run_id = ?").get(runId) as { run_json: string };
  const run = JSON.parse(row.run_json) as Run;
  // Relative to the run's own timestamp, so it works with any clock (CH-0B scenario clock).
  run.createdAt = new Date(Date.parse(run.createdAt) - minutes * 60_000).toISOString();
  e.db.prepare("UPDATE app_runs SET run_json = ?, created_at = ? WHERE run_id = ?").run(JSON.stringify(run), run.createdAt, runId);
}

function assertNothingWritten(e: TestEnv, run: Run) {
  expect(run.execution.toolCalls).toBe(0);
  expect(run.execution.result).toBeNull();
  expect(countRows(e.db, "ehr_tasks")).toBe(0);
  expect(countRows(e.db, "ehr_audit", "action IN ('TASK_CREATED','TASK_CREATE_REJECTED')")).toBe(0);
  expect(draftStatus(e)).toBe("DRAFT_INCOMPLETE");
}

describe("CH-0A pre-write re-check", () => {
  it("opt-out recorded after evaluation stops the write", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const c = await check(env!);
    expect(c.status).toBe("AWAITING_CONFIRMATION");
    env!.db.prepare("UPDATE payer_opt_out SET opted_out = 1 WHERE patient_id = 'SYN-PAT-1042'").run();
    const s = await stage(env!, c.runId);
    expect(s.status).toBe("NO_ACTION");
    expect(s.outcomeState).toBe("ACCESS_NOT_PERMITTED");
    expect(s.execution.preWriteCheck).toMatchObject({ ageOk: true, accessOk: false, passed: false, refusal: "ACCESS_NOT_PERMITTED" });
    expect(s.trace.find((t) => t.step === "PRE_WRITE_RECHECK")?.ok).toBe(false);
    assertNothingWritten(env!, s);
  });

  it("attribution removed after evaluation stops the write", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const c = await check(env!);
    env!.db.prepare("UPDATE payer_attribution SET attributed = 0 WHERE patient_id = 'SYN-PAT-1042'").run();
    const s = await stage(env!, c.runId);
    expect(s.execution.preWriteCheck?.refusal).toBe("ACCESS_NOT_PERMITTED");
    assertNothingWritten(env!, s);
  });

  it("a run older than the limit is refused before any access call", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const c = await check(env!);
    ageRun(env!, c.runId, 24 * 60 + 1);
    const authCallsBefore = countRows(env!.db, "payer_access_log", "path LIKE '%/authorization'");
    const s = await stage(env!, c.runId);
    expect(s.status).toBe("REEVALUATION_REQUIRED");
    expect(s.outcomeState).toBe("REEVALUATION_REQUIRED");
    expect(s.execution.preWriteCheck).toMatchObject({ ageOk: false, refusal: "RUN_TOO_OLD", maxAgeMinutes: 1440 });
    expect(countRows(env!.db, "payer_access_log", "path LIKE '%/authorization'")).toBe(authCallsBefore);
    assertNothingWritten(env!, s);
    // A fresh check can then be staged normally.
    const again = await stage(env!, (await check(env!)).runId);
    expect(again.status).toBe("COMPLETED");
  });

  it("a run just inside the limit is staged", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const c = await check(env!);
    ageRun(env!, c.runId, 24 * 60 - 1);
    const s = await stage(env!, c.runId);
    expect(s.status).toBe("COMPLETED");
    expect(s.execution.preWriteCheck).toMatchObject({ ageOk: true, accessOk: true, passed: true, refusal: null });
  });

  it("an unavailable access check fails closed and is safe to retry", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const c = await check(env!);
    setFault(env!.db, "payer.authorization", { kind: "status", status: 503, remaining: 3 });
    const s = await stage(env!, c.runId);
    expect(s.status).toBe("FAILED_RETRYABLE");
    expect(s.execution.preWriteCheck?.refusal).toBe("ACCESS_CHECK_UNAVAILABLE");
    assertNothingWritten(env!, s);
    const retry = await stage(env!, c.runId);
    expect(retry.status).toBe("COMPLETED");
    expect(retry.execution.toolCalls).toBe(1);
    expect(countRows(env!.db, "ehr_tasks")).toBe(1);
  });

  it("happy path records one passing re-check with a real authorization call", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const s = await stage(env!, (await check(env!)).runId);
    expect(s.status).toBe("COMPLETED");
    const step = s.trace.find((t) => t.step === "PRE_WRITE_RECHECK");
    expect(step?.ok).toBe(true);
    const recheckCall = s.trace.flatMap((t) => t.calls).filter((c) => c.path.includes("/authorization"));
    expect(recheckCall).toHaveLength(1);
  });

  it("the age limit is configurable and rejects bad values", () => {
    expect(loadConfig({ EB_MAX_RUN_AGE_HOURS: "2" }).maxRunAgeHours).toBe(2);
    expect(loadConfig({}).maxRunAgeHours).toBe(24);
    expect(loadConfig({ EB_MAX_RUN_AGE_HOURS: "-1" }).errors.join(" ")).toMatch(/EB_MAX_RUN_AGE_HOURS/);
  });
});
