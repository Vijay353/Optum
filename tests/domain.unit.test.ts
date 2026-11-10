/** Unit tests: policy EVID-1.0, integrity checks, patient match, extractor, state machine. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateEvidencePolicy } from "../src/domain/evidencePolicy";
import type { EvidencePolicyInput } from "../src/domain/contracts";
import { splitPages, validateExtractionOutput, verifyCitations, sha256Hex, canonicalJson } from "../src/domain/integrity";
import { computePatientMatch } from "../src/domain/patientMatch";
import { FixtureEvidenceExtractor } from "../src/agents/FixtureEvidenceExtractor";
import { canTransition } from "../src/domain/stateMachine";

const ok: EvidencePolicyInput = {
  patientMatch: "EXACT", providerAttributed: true, patientOptedOut: false, policyVersionMatches: true, draftVersionMatches: true,
  claimLeadCount: 12, clinicalDocumentFound: true, documentHashVerified: true, citationsValid: true, evidenceWithinLookback: true, agentAbstained: false,
};
const doc = readFileSync("fixtures/base/documents/HIE-PT-7781.txt", "utf8");

describe("evidence policy EVID-1.0", () => {
  const cases: Array<[string, Partial<EvidencePolicyInput>, string, string]> = [
    ["all checks pass", {}, "REVIEW_EXTERNAL_EVIDENCE", "R6_REVIEW_EXTERNAL_EVIDENCE"],
    ["opt-out", { patientOptedOut: true }, "ACCESS_NOT_PERMITTED", "R1_ACCESS_GATE"],
    ["no attribution", { providerAttributed: false }, "ACCESS_NOT_PERMITTED", "R1_ACCESS_GATE"],
    ["stale draft", { draftVersionMatches: false }, "INSUFFICIENT_EVIDENCE", "R2_VERSION_MISMATCH"],
    ["policy mismatch", { policyVersionMatches: false }, "INSUFFICIENT_EVIDENCE", "R2_VERSION_MISMATCH"],
    ["claims without document", { clinicalDocumentFound: false }, "CLAIM_LEAD_ONLY", "R3_CLAIM_LEAD_ONLY"],
    ["nothing at all", { clinicalDocumentFound: false, claimLeadCount: 0 }, "INSUFFICIENT_EVIDENCE", "R3_NO_EXTERNAL_EVIDENCE"],
    ["patient mismatch", { patientMatch: "NONE" }, "INSUFFICIENT_EVIDENCE", "R2_PATIENT_MISMATCH"],
    ["hash invalid", { documentHashVerified: false }, "MANUAL_REVIEW", "R4_PROVENANCE"],
    ["citations invalid", { citationsValid: false }, "MANUAL_REVIEW", "R4_PROVENANCE"],
    ["agent abstained", { agentAbstained: true }, "MANUAL_REVIEW", "R5_AMBIGUITY"],
    ["ambiguous patient", { patientMatch: "AMBIGUOUS" }, "MANUAL_REVIEW", "R5_AMBIGUITY"],
    ["outside lookback", { evidenceWithinLookback: false }, "INSUFFICIENT_EVIDENCE", "R5_LOOKBACK"],
    ["source unavailable", { sourceUnavailable: true }, "SOURCE_UNAVAILABLE", "R0_SOURCE_UNAVAILABLE"],
  ];
  it.each(cases)("%s", (_n, patch, decision, rule) => {
    const r = evaluateEvidencePolicy({ ...ok, ...patch });
    expect(r.decision).toBe(decision);
    expect(r.ruleId).toBe(rule);
    expect(r.createsTask).toBe(decision === "REVIEW_EXTERNAL_EVIDENCE");
  });
  it("no decision text implies clinical sufficiency or approval", () => {
    for (const [, patch] of cases) {
      const text = evaluateEvidencePolicy({ ...ok, ...patch }).reasons.join(" ");
      expect(text).not.toMatch(/medically necessary|criterion (is )?met|will be approved|approval likely/i);
    }
  });
  it("is deterministic", () => {
    expect(evaluateEvidencePolicy(ok)).toEqual(evaluateEvidencePolicy({ ...ok }));
  });
});

describe("agent output validation", () => {
  const valid = {
    documentId: "HIE-PT-7781", patientReferenceFound: true, evidenceType: "PHYSICAL_THERAPY_SUMMARY", ambiguity: [], abstain: false,
    facts: [{ field: "therapy_start_date", normalizedValue: "2026-01-12", sourcePage: 1, sourceStart: 0, sourceEnd: 5, quote: "x", confidence: 0.9 }],
  };
  it("accepts a well-formed extraction", () => expect(validateExtractionOutput(valid).ok).toBe(true));
  it("test 9: rejects a medical-necessity conclusion field", () => {
    const r = validateExtractionOutput({ ...valid, criterionMet: true, medicallyNecessary: true });
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/criterionMet/);
  });
  it("rejects nested prohibited keys (e.g. recommended codes, approve)", () => {
    expect(validateExtractionOutput({ ...valid, facts: [{ ...valid.facts[0], recommendedCpt: "12345" }] }).ok).toBe(false);
    expect(validateExtractionOutput({ ...valid, approve: true }).ok).toBe(false);
  });
  it("rejects verdict language in values", () => {
    const r = validateExtractionOutput({ ...valid, facts: [{ ...valid.facts[0], field: "discharge_outcome", normalizedValue: "Criteria met; procedure is medically necessary" }] });
    expect(r.ok).toBe(false);
  });
  it("test 8: a fact without citation fields fails schema validation", () => {
    const { sourceStart: _s, sourceEnd: _e, quote: _q, ...noCite } = valid.facts[0]!;
    expect(validateExtractionOutput({ ...valid, facts: [noCite] }).ok).toBe(false);
  });
  it("disallowed field names fail", () => {
    expect(validateExtractionOutput({ ...valid, facts: [{ ...valid.facts[0], field: "diagnosis" }] }).ok).toBe(false);
  });
});

describe("citations and hashing", () => {
  it("verifies exact quotes and rejects shifted offsets", () => {
    const pages = splitPages(doc);
    const i = pages[0]!.indexOf("Supervised therapy start date: 2026-01-12");
    const fact = { field: "therapy_start_date" as const, normalizedValue: "2026-01-12", sourcePage: 1, sourceStart: i, sourceEnd: i + 41, quote: "Supervised therapy start date: 2026-01-12", confidence: 1 };
    expect(verifyCitations([fact], pages).allValid).toBe(true);
    expect(verifyCitations([{ ...fact, sourceStart: i + 1, sourceEnd: i + 42 }], pages).allValid).toBe(false);
    expect(verifyCitations([{ ...fact, sourcePage: 9 }], pages).allValid).toBe(false);
  });
  it("hash changes when payload changes; canonical JSON is key-order independent", () => {
    expect(sha256Hex(doc)).not.toBe(sha256Hex(doc + " "));
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }));
  });
});

describe("FixtureEvidenceExtractor", () => {
  const ex = new FixtureEvidenceExtractor();
  it("extracts cited facts that pass citation verification", async () => {
    const pages = splitPages(doc);
    const out = await ex.extract({ documentId: "HIE-PT-7781", pages, expectedPatientId: "SYN-PAT-1042", requirementCode: "SUPERVISED_PHYSICAL_THERAPY_DOCUMENTATION" });
    expect(out.abstain).toBe(false);
    expect(out.facts.map((f) => f.field).sort()).toEqual(["discharge_outcome", "documented_visit_count", "supervision_statement", "therapy_end_date", "therapy_start_date"]);
    expect(verifyCitations(out.facts, pages).allValid).toBe(true);
    expect(validateExtractionOutput(out).ok).toBe(true);
  });
  it("test 10: ambiguous document makes the extractor abstain", async () => {
    const amb = readFileSync("fixtures/base/documents/HIE-PT-7790.txt", "utf8");
    const out = await ex.extract({ documentId: "HIE-PT-7790", pages: splitPages(amb), expectedPatientId: "SYN-PAT-1045", requirementCode: "SUPERVISED_PHYSICAL_THERAPY_DOCUMENTATION" });
    expect(out.abstain).toBe(true);
    expect(out.patientReferenceFound).toBe(false);
  });
  it("abstains on a non-PT document", async () => {
    const out = await ex.extract({ documentId: "X", pages: ["Office note for SYN-PAT-1042. Nothing else."], expectedPatientId: "SYN-PAT-1042", requirementCode: "SUPERVISED_PHYSICAL_THERAPY_DOCUMENTATION" });
    expect(out.abstain).toBe(true);
  });
});

describe("patient match", () => {
  const base = { expectedPatientId: "SYN-PAT-1042", expectedAgeBand: "55-64", documentSubjectRef: "Patient/SYN-PAT-1042", mpiMatchConfidence: "exact" as const, documentText: doc };
  it("EXACT when index, identifier and age band agree", () => expect(computePatientMatch(base).match).toBe("EXACT"));
  it("AMBIGUOUS when MPI is probabilistic", () => expect(computePatientMatch({ ...base, mpiMatchConfidence: "probable" }).match).toBe("AMBIGUOUS"));
  it("NONE when the text names another patient", () => expect(computePatientMatch({ ...base, documentText: doc.replace("SYN-PAT-1042", "SYN-PAT-1099") }).match).toBe("NONE"));
  it("NONE when the age band differs", () => expect(computePatientMatch({ ...base, expectedAgeBand: "65+" }).match).toBe("NONE"));
});

describe("state machine", () => {
  it("only DRAFT_INCOMPLETE → EVIDENCE_REVIEW_PENDING is allowed", () => {
    expect(canTransition("DRAFT_INCOMPLETE", "EVIDENCE_REVIEW_PENDING")).toBe(true);
    expect(canTransition("EVIDENCE_REVIEW_PENDING", "EVIDENCE_REVIEW_PENDING")).toBe(false);
  });
});
