/**
 * V3 CH-19: the evidence matrix agrees with what actually ran, for every scenario.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { api, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";
import type { EvidenceCheck } from "../src/orchestrator/evidenceChecks";
import { evidenceChecks, summarizeChecks } from "../src/orchestrator/evidenceChecks";
import { listScenarios } from "../src/server/scenarios";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

const POST_WRITE = new Set(["READBACK"]);
async function play(scenario: string, draft: string, stage = true) {
  env = await startTestServer({ scenario });
  const checked = (await api<{ run: Run }>(env, "POST", `/api/drafts/${draft}/check`)).body.run;
  if (stage && checked.status === "AWAITING_CONFIRMATION") await api(env, "POST", `/api/runs/${checked.runId}/stage`);
  const ws = (await api<{ evidenceChecks: EvidenceCheck[]; run: Run }>(env, "GET", "/api/workspace")).body;
  return { run: ws.run, checks: ws.evidenceChecks };
}
const byId = (checks: EvidenceCheck[]) => Object.fromEntries(checks.map((c) => [c.checkId, c.status]));

describe.each(listScenarios().map((s) => [s.id, s] as const))("matrix vs actual run: %s", (_id, sc) => {
  it("agrees with the decision, the outcome and the trace", async () => {
    const { run, checks } = await play(sc.id, sc.draftId);
    expect(checks).toEqual(evidenceChecks(run)); // the API serves exactly the server derivation
    const blocking = checks.filter((c) => c.blocksAutoAction && !POST_WRITE.has(c.checkId) && (c.status === "FAIL" || c.status === "WARN"));
    if (run.status === "COMPLETED" || run.status === "AWAITING_CONFIRMATION") expect(blocking.map((c) => c.checkId)).toEqual([]);
    if (run.policyResult && !run.policyResult.createsTask) expect(blocking.length).toBeGreaterThan(0);
    if (run.status === "REEVALUATION_REQUIRED" || run.status === "FAILED") expect(checks.some((c) => c.status === "FAIL")).toBe(true);
    // Every evaluated check that names a time matches a step that actually ran.
    const stepTimes = new Set(run.trace.map((t) => t.at));
    for (const c of checks) {
      if (c.status !== "NOT_EVALUATED" && c.evaluatedAt) expect(stepTimes.has(c.evaluatedAt) || c.checkId === "PRE_WRITE_RECHECK", c.checkId).toBe(true);
      if (c.status === "NOT_EVALUATED") expect(c.evidenceRefs).toEqual([]);
    }
    const s = summarizeChecks(checks);
    expect(s.passed + s.warned + s.blocked + s.notEvaluated).toBe(checks.length);
  });
});

describe("specific cases", () => {
  it("primary, staged: every check passed", async () => {
    const { checks } = await play("primary-success", "PA-DRAFT-99412");
    expect(summarizeChecks(checks)).toEqual({ passed: 16, warned: 0, blocked: 0, notEvaluated: 0 });
  });
  it("primary, pending: write-path checks are not evaluated, not green", async () => {
    const { checks } = await play("primary-success", "PA-DRAFT-99412", false);
    expect(byId(checks)).toMatchObject({ PRE_WRITE_RECHECK: "NOT_EVALUATED", TASK_WRITE: "NOT_EVALUATED", READBACK: "NOT_EVALUATED", CITATIONS: "PASS" });
  });
  it("opt-out: access did not pass; nothing after it ran", async () => {
    const { checks } = await play("opt-out", "PA-DRAFT-99414");
    expect(byId(checks)).toMatchObject({ PROVIDER_ACCESS: "FAIL", CLAIM_LEADS: "NOT_EVALUATED", CLINICAL_DOCUMENT: "NOT_EVALUATED", DOCUMENT_HASH: "NOT_EVALUATED", PATIENT_MATCH: "NOT_EVALUATED", CITATIONS: "NOT_EVALUATED" });
  });
  it("claims only, ambiguous, mismatch, hash, superseded, duplicate, stale write, readback", async () => {
    expect(byId((await play("claims-only", "PA-DRAFT-99413")).checks)).toMatchObject({ CLAIM_LEADS: "PASS", CLINICAL_DOCUMENT: "FAIL", DOCUMENT_HASH: "NOT_EVALUATED" });
    await env!.close();
    expect(byId((await play("ambiguous-match", "PA-DRAFT-99415")).checks)).toMatchObject({ PATIENT_MATCH: "WARN" });
    await env!.close();
    expect(byId((await play("patient-mismatch", "PA-DRAFT-99417")).checks)).toMatchObject({ PATIENT_MATCH: "FAIL", EXTRACTION_OUTPUT: "NOT_EVALUATED" });
    await env!.close();
    expect(byId((await play("hash-mismatch", "PA-DRAFT-99412")).checks)).toMatchObject({ DOCUMENT_HASH: "FAIL" });
    await env!.close();
    expect(byId((await play("policy-superseded", "PA-DRAFT-99419")).checks)).toMatchObject({ POLICY_VERSION: "FAIL", PROVIDER_ACCESS: "NOT_EVALUATED" });
    await env!.close();
    expect(byId((await play("possible-duplicate-document", "PA-DRAFT-99412")).checks)).toMatchObject({ SINGLE_CANDIDATE: "WARN" });
    await env!.close();
    expect(byId((await play("stale-version", "PA-DRAFT-99412")).checks)).toMatchObject({ PRE_WRITE_RECHECK: "PASS", TASK_WRITE: "FAIL", READBACK: "NOT_EVALUATED" });
    await env!.close();
    expect(byId((await play("readback-mismatch", "PA-DRAFT-99412")).checks)).toMatchObject({ TASK_WRITE: "PASS", READBACK: "FAIL" });
  });
  it("the browser never computes checks itself (type-only import)", () => {
    for (const f of readdirSync("src/ui")) {
      const t = readFileSync(join("src/ui", f), "utf8");
      expect(t, f).not.toMatch(/import\s+\{[^}]*\}\s+from\s+"\.\.\/orchestrator\/evidenceChecks"/);
    }
  });
});
