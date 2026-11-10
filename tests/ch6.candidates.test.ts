/**
 * V3 CH-6 (refined): more than one candidate document from the same source and
 * period is flagged for a person. Nothing is created automatically, and the
 * base fixture is unchanged (the demo case is an opt-in overlay).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, countRows, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";
import { loadScenario } from "../src/server/scenarios";
import { loadFixtureDataset } from "../src/data/datasetStore";
import { evaluateEvidencePolicy } from "../src/domain/evidencePolicy";
import type { EvidencePolicyInput } from "../src/domain/contracts";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

const check = async (e: TestEnv) => (await api<{ run: Run }>(e, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
const baseText = readFileSync("fixtures/base/documents/HIE-PT-7781.txt", "utf8");

type Extra = { id: string; authorOrgId?: string; type?: string; periodStart?: string; periodEnd?: string; date?: string; text?: string };
/** Builds a temp fixtures folder: base + one overlay with the given HIE documents, plus a scenario using it. */
function tempScenario(extra: Extra[]): string {
  const dir = mkdtempSync(join(tmpdir(), "eb-ch6-"));
  cpSync("fixtures/base", join(dir, "base"), { recursive: true });
  mkdirSync(join(dir, "ov", "documents"), { recursive: true });
  writeFileSync(join(dir, "ov", "document_references.json"), JSON.stringify(extra.map((e) => ({
    source: "HIE", id: e.id, indexedPatientId: "SYN-PAT-1042", matchConfidence: "exact",
    authorOrgId: e.authorOrgId ?? "SYN-ORG-PT-301", authorName: "Synthetic clinic (fictional)",
    type: e.type ?? "pt-discharge-summary", title: "Synthetic test document", date: e.date ?? "2026-03-11",
    periodStart: e.periodStart ?? "2026-01-12", periodEnd: e.periodEnd ?? "2026-03-09", contentType: "text/plain",
  }))));
  for (const e of extra) writeFileSync(join(dir, "ov", "documents", `${e.id}.txt`), e.text ?? baseText.replace("12 supervised visits", "11 supervised visits"));
  mkdirSync(join(dir, "t"));
  const sc = JSON.parse(readFileSync("fixtures/primary-success/scenario.json", "utf8"));
  writeFileSync(join(dir, "t", "scenario.json"), JSON.stringify({ ...sc, id: "t", overlays: ["ov"] }));
  return dir;
}
async function runWith(extra: Extra[]): Promise<Run> {
  env = await startTestServer();
  loadScenario(env.db, "t", {}, tempScenario(extra));
  return check(env);
}

describe("policy EVID-1.1", () => {
  const ok: EvidencePolicyInput = {
    patientMatch: "EXACT", providerAttributed: true, patientOptedOut: false, policyVersionMatches: true, draftVersionMatches: true,
    claimLeadCount: 12, clinicalDocumentFound: true, documentHashVerified: true, citationsValid: true, evidenceWithinLookback: true, agentAbstained: false,
  };
  it("one or more other candidates goes to manual review", () => {
    expect(evaluateEvidencePolicy({ ...ok, otherCandidateDocumentCount: 1 })).toMatchObject({ decision: "MANUAL_REVIEW", ruleId: "R5_MULTIPLE_CANDIDATES", createsTask: false, policyVersion: "EVID-1.1" });
    expect(evaluateEvidencePolicy({ ...ok, otherCandidateDocumentCount: 0 }).ruleId).toBe("R6_REVIEW_EXTERNAL_EVIDENCE");
    expect(evaluateEvidencePolicy(ok).ruleId).toBe("R6_REVIEW_EXTERNAL_EVIDENCE");
  });
  it("earlier rules still decide first", () => {
    expect(evaluateEvidencePolicy({ ...ok, otherCandidateDocumentCount: 2, patientOptedOut: true }).ruleId).toBe("R1_ACCESS_GATE");
    expect(evaluateEvidencePolicy({ ...ok, otherCandidateDocumentCount: 2, agentAbstained: true }).ruleId).toBe("R5_AMBIGUITY");
  });
  it("wording does not accuse anyone", () => {
    const text = evaluateEvidencePolicy({ ...ok, otherCandidateDocumentCount: 1 }).reasons.join(" ");
    expect(text).not.toMatch(/fraud|forg|fake|tamper|suspicious/i);
  });
});

describe("shipped opt-in scenario", () => {
  it("flags both documents, creates nothing, and cannot be staged by any role", async () => {
    env = await startTestServer({ scenario: "possible-duplicate-document" });
    const c = await check(env);
    expect(c.policyResult).toMatchObject({ decision: "MANUAL_REVIEW", ruleId: "R5_MULTIPLE_CANDIDATES" });
    expect(c.candidates?.map((d) => [d.id, d.selected, d.sameContentAsSelected])).toEqual([["HIE-PT-7782", true, false], ["HIE-PT-7781", false, false]]);
    expect(c.stagedToolInput).toBeNull();
    for (const role of ["pa-specialist", "viewer", "sim-admin"]) expect((await api(env, "POST", `/api/runs/${c.runId}/stage`, undefined, role)).status, role).toBe(403);
    expect(countRows(env.db, "ehr_tasks")).toBe(0);
    expect(countRows(env.db, "app_audit", "type = 'POSSIBLE_DUPLICATE_DOCUMENT'")).toBe(1);
    // Running the check again flags once more for the new run, never twice for one run.
    await check(env);
    expect(countRows(env.db, "app_audit", "type = 'POSSIBLE_DUPLICATE_DOCUMENT'")).toBe(2);
    expect(countRows(env.db, "ehr_tasks")).toBe(0);
  });

  it("the base fixture is unchanged (six HIE documents, one per patient)", () => {
    const { dataset, issues } = loadFixtureDataset("fixtures/base");
    expect(issues).toEqual([]);
    const hie = dataset.document_references.filter((d) => d.source === "HIE");
    expect(hie).toHaveLength(6);
    expect(hie.map((d) => d.id)).not.toContain("HIE-PT-7782");
  });
});

describe("what is not flagged", () => {
  it("a summary from a different clinic", async () => {
    const c = await runWith([{ id: "HIE-PT-9001", authorOrgId: "SYN-ORG-PT-302" }]);
    expect(c.policyResult?.decision).toBe("REVIEW_EXTERNAL_EVIDENCE");
    expect(c.candidates).toHaveLength(1);
  });
  it("a progress note from the same clinic and period (a different document type)", async () => {
    const c = await runWith([{ id: "HIE-PT-9002", type: "pt-progress-note" }]);
    expect(c.policyResult?.decision).toBe("REVIEW_EXTERNAL_EVIDENCE");
  });
  it("a summary whose period ends the day before the first claim", async () => {
    const c = await runWith([{ id: "HIE-PT-9003", periodStart: "2025-11-01", periodEnd: "2026-01-11", date: "2026-01-11" }]);
    expect(c.policyResult?.decision).toBe("REVIEW_EXTERNAL_EVIDENCE");
  });
});

describe("what is flagged", () => {
  it("a summary whose period ends exactly on the first claim date", async () => {
    const c = await runWith([{ id: "HIE-PT-9004", periodStart: "2025-11-01", periodEnd: "2026-01-12", date: "2026-01-12" }]);
    expect(c.policyResult?.ruleId).toBe("R5_MULTIPLE_CANDIDATES");
  });
  it("an exact copy under a new id is flagged and marked as the same content", async () => {
    const c = await runWith([{ id: "HIE-PT-9005", date: "2026-03-01", text: baseText }]);
    expect(c.policyResult?.ruleId).toBe("R5_MULTIPLE_CANDIDATES");
    expect(c.candidates?.find((d) => d.id === "HIE-PT-9005")).toMatchObject({ selected: false, sameContentAsSelected: true });
  });
});
