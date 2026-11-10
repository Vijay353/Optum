/** Spec §19 reliability, access and privacy tests (12–21) plus Examples E–H. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, countRows, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";
import { setLogSilent } from "../src/server/logger";
import { setFault } from "../src/simulators/shared";

let env: TestEnv;
afterEach(async () => { await env?.close(); });

async function checkAndStage(e: TestEnv, draft = "PA-DRAFT-99412") {
  const c = (await api<{ run: Run }>(e, "POST", `/api/drafts/${draft}/check`)).body.run;
  const s = (await api<{ run: Run }>(e, "POST", `/api/runs/${c.runId}/stage`)).body.run;
  return { c, s };
}

describe("reliability", () => {
  it("Example G: duplicate event delivery returns the same task with duplicate:true", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const first = await checkAndStage(env);
    expect(first.s.execution.result?.duplicate).toBe(false);
    const second = await checkAndStage(env);
    expect(second.c.deliveryCount).toBe(2);
    expect(second.c.event.eventId).toBe(first.c.event.eventId);
    expect(second.s.status).toBe("COMPLETED");
    expect(second.s.execution.result).toMatchObject({ taskId: "TASK-EVID-1042", duplicate: true });
    expect(countRows(env.db, "ehr_tasks")).toBe(1);
    expect(countRows(env.db, "ehr_audit", "action = 'TASK_CREATE_REPLAYED'")).toBe(1);
  });

  it("Example H: draft edited between evaluation and staging → write fails closed, context reloaded", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const c = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    const edit = await api<{ draft: { version: number } }>(env, "POST", "/api/drafts/PA-DRAFT-99412/simulate-edit");
    expect(edit.body.draft.version).toBe(4);
    const s = (await api<{ run: Run }>(env, "POST", `/api/runs/${c.runId}/stage`)).body.run;
    expect(s.status).toBe("REEVALUATION_REQUIRED");
    expect(s.execution.error?.status).toBe(409);
    expect(s.context?.draft.version).toBe(4);
    expect(countRows(env.db, "ehr_tasks")).toBe(0);
    // A fresh check for v4 then succeeds.
    const again = await checkAndStage(env);
    expect(again.c.event.eventId).toBe("evt-pa-99412-v4");
    expect(again.s.status).toBe("COMPLETED");
  });

  it("stale event: re-processing an old v3 event after the draft moved to v4 makes no external calls", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const c = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    await api(env, "POST", "/api/drafts/PA-DRAFT-99412/simulate-edit");
    const { processPriorAuthDraft } = await import("../src/orchestrator/processPriorAuthDraft");
    const before = countRows(env.db, "payer_access_log");
    const r = await processPriorAuthDraft(env.handle.deps(), c.event);
    expect(r.policyResult?.ruleId).toBe("R2_VERSION_MISMATCH");
    expect(r.outcomeState).toBe("REEVALUATION_REQUIRED");
    expect(countRows(env.db, "payer_access_log")).toBe(before);
  });

  it("lost response after commit: retry replays idempotently, one task, readback verified", async () => {
    env = await startTestServer({ scenario: "lost-response-retry" });
    const { s } = await checkAndStage(env);
    expect(s.status).toBe("COMPLETED");
    expect(s.execution.result?.duplicate).toBe(true);
    const toolStep = s.trace.find((t) => t.step.startsWith("TOOL_CALL"));
    expect(toolStep?.calls.map((c) => c.status)).toEqual([503, 200]);
    expect(countRows(env.db, "ehr_tasks")).toBe(1);
  });

  it("429 once on claims: jittered retry recovers", async () => {
    env = await startTestServer({ scenario: "throttled-then-ok" });
    const { c } = await checkAndStage(env);
    const step = c.trace.find((t) => t.step === "CLAIM_LEADS");
    expect(step?.calls.map((x) => x.status)).toEqual([429, 200]);
  });

  it("Provider Access timeout → SOURCE_UNAVAILABLE after bounded attempts, no mutation", async () => {
    env = await startTestServer({ scenario: "source-unavailable" });
    const c = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    expect(c.policyResult?.decision).toBe("SOURCE_UNAVAILABLE");
    const step = c.trace.find((t) => t.step === "CLAIM_LEADS");
    expect(step?.calls).toHaveLength(3);
    expect(step?.calls.every((x) => x.outcome === "timeout")).toBe(true);
    expect(countRows(env.db, "ehr_tasks")).toBe(0);
  });

  it("transient EHR failure on task write → FAILED_RETRYABLE; retry with same key succeeds once", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    setFault(env.db, "ehr.task.create", { kind: "status", status: 503, remaining: 3 });
    const { c, s } = await checkAndStage(env);
    expect(s.status).toBe("FAILED_RETRYABLE");
    expect(countRows(env.db, "ehr_tasks")).toBe(0);
    const retry = (await api<{ run: Run }>(env, "POST", `/api/runs/${c.runId}/stage`)).body.run;
    expect(retry.status).toBe("COMPLETED");
    expect(retry.execution.toolCalls).toBe(2);
    expect(countRows(env.db, "ehr_tasks")).toBe(1);
  });

  it("cannot stage a run twice once completed", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const { c } = await checkAndStage(env);
    const again = await api<{ error: string }>(env, "POST", `/api/runs/${c.runId}/stage`);
    expect(again.status).toBe(403);
    expect(countRows(env.db, "ehr_tasks")).toBe(1);
  });
});

describe("access and privacy", () => {
  it("Example E: opt-out stops before any claims or HIE request", async () => {
    env = await startTestServer({ scenario: "opt-out" });
    const c = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99414/check")).body.run;
    expect(c.policyResult?.decision).toBe("ACCESS_NOT_PERMITTED");
    expect(countRows(env.db, "payer_access_log", "path LIKE '%ExplanationOfBenefit%'")).toBe(0);
    expect(countRows(env.db, "hie_access_log")).toBe(0);
    expect(c.claims).toBeNull();
    expect(c.document).toBeNull();
  });

  it("payer simulator itself refuses EOBs for opted-out patients (defence in depth)", async () => {
    env = await startTestServer({ scenario: "opt-out" });
    const res = await fetch(`${env.baseUrl}/mock-payer/fhir/ExplanationOfBenefit?patient=SYN-PAT-1044`, {
      headers: { authorization: "Bearer eb-orchestrator-local", "x-requesting-provider": "SYN-ORG-ORTHO-100" },
    });
    expect(res.status).toBe(403);
  });

  it("payer simulator exposes no write/submission endpoint", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const res = await fetch(`${env.baseUrl}/mock-payer/fhir/Claim/$submit`, { method: "POST", headers: { authorization: "Bearer eb-orchestrator-local" } });
    expect(res.status).toBe(405);
  });

  it("orchestrator credentials cannot edit the draft (no Draft.write scope)", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const res = await fetch(`${env.baseUrl}/mock-ehr/prior-auth-drafts/PA-DRAFT-99412`, {
      method: "PATCH", headers: { authorization: "Bearer eb-orchestrator-local", "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: 3 }),
    });
    expect(res.status).toBe(403);
  });

  it("patient mismatch: document is not processed and nothing is attached", async () => {
    env = await startTestServer({ scenario: "patient-mismatch" });
    const c = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99417/check")).body.run;
    expect(c.patientMatch?.match).toBe("NONE");
    expect(c.extraction?.skippedReason).toMatch(/patient mismatch/);
    expect(c.stagedToolInput).toBeNull();
  });

  it("logs contain no document body and no direct identifiers", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    const spyErr = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    setLogSilent(false);
    try {
      await checkAndStage(env);
    } finally {
      setLogSilent(true);
      spy.mockRestore();
      spyErr.mockRestore();
    }
    const all = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(all).not.toMatch(/SYN-PAT-\d+/);
    expect(all).not.toMatch(/persistent low back/);
    expect(all).not.toMatch(/Supervised therapy start date/);
    // Audit details hold ids/hashes only
    const audit = (env.db.prepare("SELECT detail_json FROM app_audit").all() as { detail_json: string }[]).map((r) => r.detail_json).join("\n");
    expect(audit).not.toMatch(/persistent low back/);
  });
});

describe("prompt injection", () => {
  it("instruction text inside the document is flagged as data and cannot change policy or tools", async () => {
    env = await startTestServer({ scenario: "prompt-injection" });
    const { c, s } = await checkAndStage(env, "PA-DRAFT-99418");
    expect(c.extraction?.output?.ambiguity.some((a) => /Instruction-like text/.test(a))).toBe(true);
    expect(JSON.stringify(c.extraction?.output)).not.toMatch(/criterionMet|medicallyNecessary/);
    expect(c.policyResult?.decision).toBe("REVIEW_EXTERNAL_EVIDENCE"); // decided only by deterministic inputs
    expect(s.execution.toolCalls).toBe(1);
    expect(s.execution.result?.payerSubmissionPerformed).toBe(false);
    expect(countRows(env.db, "payer_access_log", "method <> 'GET'")).toBe(0);
  });
});

describe("configuration fails closed", () => {
  it("SANDBOX mode without real credentials refuses to run and never falls back to simulation", async () => {
    env = await startTestServer({ scenario: "primary-success", env: { EB_MODE: "SANDBOX" } });
    const h = await api<{ ok: boolean; configErrors: string[] }>(env, "GET", "/api/health");
    expect(h.body.ok).toBe(false);
    const res = await api<{ error: string }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check");
    expect(res.status).toBe(503);
    expect(countRows(env.db, "payer_access_log")).toBe(0);
  });

  it("LLM extractor selected without a key fails closed", async () => {
    env = await startTestServer({ scenario: "primary-success", env: { EB_EXTRACTOR: "llm" } });
    const res = await api(env, "POST", "/api/drafts/PA-DRAFT-99412/check");
    expect(res.status).toBe(503);
  });
});
