/**
 * Every scenario fixture end-to-end through real HTTP: event → decision →
 * (stage when allowed) → independent assertions on simulator storage.
 */
import { afterEach, describe, expect, it } from "vitest";
import { api, countRows, startTestServer, type TestEnv } from "./helpers";
import { listScenarios } from "../src/server/scenarios";
import type { Run } from "../src/orchestrator/runTypes";

let env: TestEnv | null = null;
afterEach(async () => { await env?.close(); env = null; });

const draftStatus = (e: TestEnv, id: string) =>
  (e.db.prepare("SELECT business_status, version FROM ehr_prior_auth_drafts WHERE id = ?").get(id) as { business_status: string; version: number });

describe.each(listScenarios().map((s) => [s.id, s] as const))("scenario %s", (_id, sc) => {
  it(`decision ${sc.expected.decision} → ${sc.expected.outcomeState}`, async () => {
    env = await startTestServer({ scenario: sc.id });
    const check = await api<{ run: Run }>(env, "POST", `/api/drafts/${sc.draftId}/check`);
    expect(check.status).toBe(200);
    let run = check.body.run;
    expect(run.policyResult?.decision).toBe(sc.expected.decision);
    if (run.status === "AWAITING_CONFIRMATION") {
      run = (await api<{ run: Run }>(env, "POST", `/api/runs/${run.runId}/stage`)).body.run;
    }
    expect(run.outcomeState).toBe(sc.expected.outcomeState);
    const tasks = countRows(env.db, "ehr_tasks");
    const status = draftStatus(env, sc.draftId);
    if (sc.id === "readback-mismatch") {
      // The EHR committed a task, but the readback did not match: never reported as success.
      expect(run.status).toBe("FAILED");
      expect(run.execution.readback?.verified).toBe(false);
      expect(tasks).toBe(1);
    } else if (sc.expected.createsTask) {
      expect(run.status).toBe("COMPLETED");
      expect(tasks).toBe(1);
      expect(status.business_status).toBe("EVIDENCE_REVIEW_PENDING");
    } else {
      expect(tasks).toBe(0);
      expect(status.business_status).toBe("DRAFT_INCOMPLETE");
    }
    // Universal invariants: no payer writes, no chart writes.
    expect(countRows(env.db, "payer_access_log", "method <> 'GET'")).toBe(0);
    expect(countRows(env.db, "ehr_documents")).toBe(8);
  });
});
