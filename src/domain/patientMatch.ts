/**
 * Deterministic patient correlation for an external document.
 * A plausible code match is never sufficient (spec §5.3).
 */
import type { PatientMatch } from "./contracts";

export type PatientMatchInput = {
  expectedPatientId: string;
  expectedAgeBand: string;
  documentSubjectRef: string; // e.g. Patient/SYN-PAT-1042 from the HIE index
  mpiMatchConfidence: "exact" | "probable";
  documentText: string;
};

export type PatientMatchResult = { match: PatientMatch; reasons: string[] };

export function computePatientMatch(i: PatientMatchInput): PatientMatchResult {
  const reasons: string[] = [];
  const ids = [...new Set(i.documentText.match(/SYN-PAT-\d{3,6}\b/g) ?? [])];
  const ageBand = /Age band:\s*([0-9+-]+)/.exec(i.documentText)?.[1];
  const subjectId = i.documentSubjectRef.split("/").pop();

  if (subjectId !== i.expectedPatientId) {
    reasons.push("HIE index subject differs from the requested patient.");
    return { match: "NONE", reasons };
  }
  if (ids.length > 0 && !ids.includes(i.expectedPatientId)) {
    reasons.push("Document text names a different patient identifier.");
    return { match: "NONE", reasons };
  }
  if (ageBand && ageBand !== i.expectedAgeBand) {
    reasons.push(`Document age band ${ageBand} differs from patient age band ${i.expectedAgeBand}.`);
    return { match: "NONE", reasons };
  }
  if (ids.length > 1) reasons.push("Document references multiple patient identifiers.");
  if (ids.length === 0) reasons.push("Document has no legible patient identifier.");
  if (!ageBand) reasons.push("Document has no age band for demographic correlation.");
  if (i.mpiMatchConfidence !== "exact") reasons.push("HIE MPI correlation is probabilistic, not exact.");
  if (reasons.length) return { match: "AMBIGUOUS", reasons };

  return { match: "EXACT", reasons: ["HIE index, document identifier and age band all agree."] };
}
