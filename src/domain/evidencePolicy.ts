/**
 * Deterministic evidence policy EVID-1.1 (spec §12; EVID-1.0 plus R5_MULTIPLE_CANDIDATES, V3 CH-6).
 *
 * Pure function: same input → same output. No model, no I/O.
 * No decision returned here implies clinical sufficiency, medical necessity
 * or likely payer approval (rule 7). REVIEW_EXTERNAL_EVIDENCE only means a
 * candidate document passed technical provenance checks and needs a human.
 */
import { POLICY_ENGINE_VERSION, type EvidencePolicyInput, type PolicyResult } from "./contracts";

const V = POLICY_ENGINE_VERSION;

function result(partial: Omit<PolicyResult, "policyVersion">): PolicyResult {
  return { ...partial, policyVersion: V };
}

export function evaluateEvidencePolicy(input: EvidencePolicyInput): PolicyResult {
  // R0 — an upstream source failed after bounded retries. Fail closed.
  if (input.sourceUnavailable) {
    return result({
      decision: "SOURCE_UNAVAILABLE",
      outcomeState: "SOURCE_UNAVAILABLE",
      createsTask: false,
      ruleId: "R0_SOURCE_UNAVAILABLE",
      reasons: ["An external source did not respond after bounded retries; no evidence was evaluated."],
    });
  }

  // R2a — stale draft or policy version. Checked before the access gate so no
  // external data is retrieved for a stale context (minimum necessary).
  if (!input.draftVersionMatches || !input.policyVersionMatches) {
    const reasons: string[] = [];
    if (!input.draftVersionMatches) reasons.push("Draft version changed since the event was emitted.");
    if (!input.policyVersionMatches) reasons.push("Policy version on the draft does not match the policy evaluated.");
    return result({
      decision: "INSUFFICIENT_EVIDENCE",
      outcomeState: "REEVALUATION_REQUIRED",
      createsTask: false,
      ruleId: "R2_VERSION_MISMATCH",
      reasons,
    });
  }

  // R1 — consent / attribution gate. No retrieval, no task.
  if (input.patientOptedOut || !input.providerAttributed) {
    const reasons: string[] = [];
    if (input.patientOptedOut) reasons.push("Patient has opted out of Provider Access data sharing.");
    if (!input.providerAttributed) reasons.push("Provider is not attributed to this patient by the payer.");
    return result({
      decision: "ACCESS_NOT_PERMITTED",
      outcomeState: "ACCESS_NOT_PERMITTED",
      createsTask: false,
      ruleId: "R1_ACCESS_GATE",
      reasons,
    });
  }

  // R3 — claims but no clinical document → lead only.
  if (!input.clinicalDocumentFound) {
    if (input.claimLeadCount > 0) {
      return result({
        decision: "CLAIM_LEAD_ONLY",
        outcomeState: "CLAIM_SOURCE_FOLLOWUP",
        createsTask: false,
        ruleId: "R3_CLAIM_LEAD_ONLY",
        reasons: [
          `${input.claimLeadCount} adjudicated claim line(s) identify a possible external source.`,
          "No clinical document was found. Claims do not prove treatment completion or outcome.",
        ],
      });
    }
    return result({
      decision: "INSUFFICIENT_EVIDENCE",
      outcomeState: "MANUAL_REVIEW",
      createsTask: false,
      ruleId: "R3_NO_EXTERNAL_EVIDENCE",
      reasons: ["No claim leads and no external clinical document were found."],
    });
  }

  // R2b — document belongs to a different patient.
  if (input.patientMatch === "NONE") {
    return result({
      decision: "INSUFFICIENT_EVIDENCE",
      outcomeState: "MANUAL_REVIEW",
      createsTask: false,
      ruleId: "R2_PATIENT_MISMATCH",
      reasons: ["The external document does not match this synthetic patient. It must not be attached."],
    });
  }

  // R4 — provenance integrity.
  if (!input.documentHashVerified || !input.citationsValid) {
    const reasons: string[] = [];
    if (!input.documentHashVerified) reasons.push("Document hash does not match the retrieved payload.");
    if (!input.citationsValid) reasons.push("One or more extracted facts lack a valid exact citation.");
    return result({
      decision: "MANUAL_REVIEW",
      outcomeState: "MANUAL_REVIEW",
      createsTask: false,
      ruleId: "R4_PROVENANCE",
      reasons,
    });
  }

  // R5 — ambiguity / abstention.
  if (input.patientMatch === "AMBIGUOUS" || input.agentAbstained) {
    const reasons: string[] = [];
    if (input.patientMatch === "AMBIGUOUS") reasons.push("Patient correlation is ambiguous; demographic match is insufficient.");
    if (input.agentAbstained) reasons.push("The extractor abstained because the document was ambiguous.");
    return result({
      decision: "MANUAL_REVIEW",
      outcomeState: "MANUAL_REVIEW",
      createsTask: false,
      ruleId: "R5_AMBIGUITY",
      reasons,
    });
  }

  // R5c (EVID-1.1, V3 CH-6) — more than one candidate document for the same source and period.
  const others = input.otherCandidateDocumentCount ?? 0;
  if (others > 0) {
    return result({
      decision: "MANUAL_REVIEW",
      outcomeState: "MANUAL_REVIEW",
      createsTask: false,
      ruleId: "R5_MULTIPLE_CANDIDATES",
      reasons: [
        `${others + 1} documents from the same source cover the same therapy period.`,
        "They may be an original and an amended copy, or separate summaries. A person must decide which one applies.",
      ],
    });
  }

  // R5b — outside lookback window.
  if (!input.evidenceWithinLookback) {
    return result({
      decision: "INSUFFICIENT_EVIDENCE",
      outcomeState: "MANUAL_REVIEW",
      createsTask: false,
      ruleId: "R5_LOOKBACK",
      reasons: ["The candidate evidence falls outside the synthetic policy lookback window."],
    });
  }

  // R6 — exact match + verified document + valid citations.
  return result({
    decision: "REVIEW_EXTERNAL_EVIDENCE",
    outcomeState: "EVIDENCE_REVIEW_PENDING",
    createsTask: true,
    ruleId: "R6_REVIEW_EXTERNAL_EVIDENCE",
    reasons: [
      "Candidate external evidence passed patient, version, hash, citation and lookback checks.",
      "This does not mean the coverage requirement is clinically satisfied. A human must review it.",
    ],
  });
}
