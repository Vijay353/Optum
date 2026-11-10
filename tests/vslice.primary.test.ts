/**
 * G1 vertical slice — spec §19 core workflow tests 1–6.
 * Real HTTP into stateful simulators; no mocks of the orchestrator path.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, countRows, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";

let env: TestEnv;
beforeEach(async () => { env = await startTestServer({ scenario: "primary-success" }); });
afterEach(async () => { await env.close(); });

describe("primary vertical slice", () => {
  it("event → REVIEW_EXTERNAL_EVIDENCE → one task → verified DRAFT_INCOMPLETE → EVIDENCE_REVIEW_PENDING", async () => {
    // Before: draft is incomplete and no task exists (independent read from simulator state)
    expect(countRows(env.db, "ehr_tasks")).toBe(0);
    const before = env.db.prepare("SELECT business_status, version FROM ehr_prior_auth_drafts WHERE id = 'PA-DRAFT-99412'").get() as { business_status: string; version: number };
    expect(before).toEqual({ business_status: "DRAFT_INCOMPLETE", version: 3 });

    // 1. Trigger: EHR emits PriorAuthDraftCreated; orchestrator evaluates
    const check = await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check");
    expect(check.status).toBe(200);
    const evaluated = check.body.run;
    expect(evaluated.event.eventId).toBe("evt-pa-99412-v3");
    expect(evaluated.policyResult?.decision).toBe("REVIEW_EXTERNAL_EVIDENCE");
    expect(evaluated.status).toBe("AWAITING_CONFIRMATION");
    expect(evaluated.claims?.leadCount).toBe(12);
    expect(evaluated.claims?.firstDate).toBe("2026-01-12");
    expect(evaluated.claims?.lastDate).toBe("2026-03-09");
    expect(evaluated.document?.id).toBe("HIE-PT-7781");
    expect(evaluated.document?.hashVerified).toBe(true);
    expect(evaluated.patientMatch?.match).toBe("EXACT");
    const facts = Object.fromEntries((evaluated.extraction?.output?.facts ?? []).map((f) => [f.field, f.normalizedValue]));
    expect(facts).toMatchObject({ therapy_start_date: "2026-01-12", therapy_end_date: "2026-03-09", documented_visit_count: 12 });
    expect(evaluated.extraction?.citationChecks.every((c) => c.valid)).toBe(true);
    // Evaluation alone mutates nothing
    expect(countRows(env.db, "ehr_tasks")).toBe(0);

    // 2. Human confirmation executes the one mutating tool
    const staged = await api<{ run: Run }>(env, "POST", `/api/runs/${evaluated.runId}/stage`);
    expect(staged.status).toBe(200);
    const run = staged.body.run;
    expect(run.status).toBe("COMPLETED");
    expect(run.execution.toolCalls).toBe(1);
    expect(run.execution.result).toMatchObject({
      taskId: "TASK-EVID-1042", status: "requested", businessStatus: "EVIDENCE_REVIEW_PENDING", duplicate: false,
      chartMutationPerformed: false, payerSubmissionPerformed: false,
    });
    expect(run.execution.stateChange).toEqual({ from: "DRAFT_INCOMPLETE", to: "EVIDENCE_REVIEW_PENDING", persisted: true });
    expect(run.execution.readback?.verified).toBe(true);
    expect(run.execution.readback?.checks.every((c) => c.pass)).toBe(true);
    expect(run.execution.payerWriteRequests).toBe(0);

    // 3. Independent assertions straight from simulator storage
    expect(countRows(env.db, "ehr_tasks")).toBe(1);
    const after = env.db.prepare("SELECT business_status, version FROM ehr_prior_auth_drafts WHERE id = 'PA-DRAFT-99412'").get() as { business_status: string; version: number };
    expect(after).toEqual({ business_status: "EVIDENCE_REVIEW_PENDING", version: 3 });
    const task = JSON.parse((env.db.prepare("SELECT resource_json FROM ehr_tasks").get() as { resource_json: string }).resource_json);
    expect(task.owner.reference).toBe("CareTeam/pa-specialist-queue");
    expect(task.focus.reference).toBe("ServiceRequest/SR-99412");
    expect(countRows(env.db, "ehr_audit", "action = 'TASK_CREATED'")).toBe(1);
    expect(countRows(env.db, "payer_access_log", "method <> 'GET'")).toBe(0);
    // No chart write: local documents unchanged
    expect(countRows(env.db, "ehr_documents", "patient_id = 'SYN-PAT-1042'")).toBe(1);
  });

  it("negative: a read-only viewer cannot stage the task", async () => {
    const check = await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check");
    const res = await api<{ error: string }>(env, "POST", `/api/runs/${check.body.run.runId}/stage`, undefined, "viewer");
    expect(res.status).toBe(403);
    expect(countRows(env.db, "ehr_tasks")).toBe(0);
    const draft = env.db.prepare("SELECT business_status FROM ehr_prior_auth_drafts WHERE id = 'PA-DRAFT-99412'").get() as { business_status: string };
    expect(draft.business_status).toBe("DRAFT_INCOMPLETE");
  });
});
