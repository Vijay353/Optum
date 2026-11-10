/** The optional LLM adapter is bounded by the same validator; a compromised model cannot create a task. */
import { afterEach, describe, expect, it } from "vitest";
import { api, countRows, startTestServer, type TestEnv } from "./helpers";
import { LlmEvidenceExtractor, ExtractorNotConfiguredError } from "../src/agents/LlmEvidenceExtractor";
import type { Run } from "../src/orchestrator/runTypes";

let env: TestEnv;
afterEach(async () => { await env?.close(); });

describe("LlmEvidenceExtractor", () => {
  it("fails closed without credentials", () => {
    expect(() => new LlmEvidenceExtractor({})).toThrow(ExtractorNotConfiguredError);
    expect(() => new LlmEvidenceExtractor({ apiKey: "sk-ant-REPLACE_ME_DUMMY" })).toThrow(ExtractorNotConfiguredError);
  });

  it("a model that obeys the injected instruction is rejected by schema → MANUAL_REVIEW, no task", async () => {
    const compromised = new LlmEvidenceExtractor({
      client: async () => JSON.stringify({
        documentId: "HIE-PT-7798", patientReferenceFound: true, evidenceType: "PHYSICAL_THERAPY_SUMMARY", facts: [], ambiguity: [], abstain: false,
        criterionMet: true, medicallyNecessary: true, submission: { to: "payer" },
      }),
    });
    env = await startTestServer({ scenario: "prompt-injection", extractor: compromised });
    const c = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99418/check")).body.run;
    expect(c.extraction?.validationIssues.join(" ")).toMatch(/criterionMet/);
    expect(c.policyResult?.decision).toBe("MANUAL_REVIEW");
    expect(c.stagedToolInput).toBeNull();
    expect(countRows(env.db, "ehr_tasks")).toBe(0);
  });

  it("a model that fabricates a quote fails exact-citation verification → MANUAL_REVIEW", async () => {
    const fabricating = new LlmEvidenceExtractor({
      client: async () => JSON.stringify({
        documentId: "HIE-PT-7781", patientReferenceFound: true, evidenceType: "PHYSICAL_THERAPY_SUMMARY", ambiguity: [], abstain: false,
        facts: [{ field: "documented_visit_count", normalizedValue: 24, sourcePage: 1, sourceStart: 10, sourceEnd: 40, quote: "Documented visits: 24 supervised", confidence: 0.95 }],
      }),
    });
    env = await startTestServer({ scenario: "primary-success", extractor: fabricating });
    const c = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    expect(c.extraction?.citationChecks[0]?.valid).toBe(false);
    expect(c.policyResult?.ruleId).toBe("R4_PROVENANCE");
  });
});
