/**
 * FixtureEvidenceExtractor — DEFAULT, deterministic, no network, no model.
 *
 * Rule-based pattern extraction adequate for the synthetic document format
 * used by this prototype. It does NOT reproduce open-ended natural-language
 * understanding; documents outside the expected format cause abstention.
 * Offsets are computed from the actual page text, so citations are real.
 */
import type { EvidenceExtraction, EvidenceExtractionInput, EvidenceFact, ExtractionField } from "../domain/contracts";
import { INSTRUCTION_LIKE, type EvidenceExtractor } from "./EvidenceExtractor";

type Rule = {
  field: ExtractionField;
  pattern: RegExp; // must capture the value in group 1; whole match is the cited quote
  normalize: (m: RegExpExecArray) => string | number | null;
};

const RULES: Rule[] = [
  { field: "therapy_start_date", pattern: /Supervised therapy start date:\s*(\d{4}-\d{2}-\d{2})/, normalize: (m) => m[1] ?? null },
  { field: "therapy_end_date", pattern: /Supervised therapy end date:\s*(\d{4}-\d{2}-\d{2})/, normalize: (m) => m[1] ?? null },
  { field: "documented_visit_count", pattern: /Documented visits:\s*(\d{1,3}) supervised visits attended[^\n]*/, normalize: (m) => Number(m[1]) },
  { field: "supervision_statement", pattern: /Supervision:\s*([^\n]+)/, normalize: (m) => (m[1] ?? "").trim() },
  { field: "discharge_outcome", pattern: /Discharge status:\s*([^\n]+)/, normalize: (m) => (m[1] ?? "").trim() },
];

const PATIENT_LINE = /Patient identifier:\s*([^\n]+)/;
const PATIENT_ID = /SYN-PAT-\d{3,6}\b/g;

export class FixtureEvidenceExtractor implements EvidenceExtractor {
  readonly kind = "fixture" as const;

  async extract(input: EvidenceExtractionInput): Promise<EvidenceExtraction> {
    const ambiguity: string[] = [];
    const full = input.pages.join("\n");
    const isPtSummary = /PHYSICAL THERAPY DISCHARGE SUMMARY/.test(full);

    const patientLine = PATIENT_LINE.exec(full)?.[1] ?? "";
    const idsOnLine: string[] = patientLine.match(PATIENT_ID) ?? [];
    const allIds: string[] = [...new Set<string>(full.match(PATIENT_ID) ?? [])];
    const patientReferenceFound = idsOnLine.length === 1 && idsOnLine[0] === input.expectedPatientId && allIds.length === 1;
    if (!patientLine) ambiguity.push("No patient identifier line found in the document.");
    else if (idsOnLine.length === 0) ambiguity.push("Patient identifier on the document is incomplete or illegible.");
    else if (!idsOnLine.includes(input.expectedPatientId)) ambiguity.push("Document names a different patient identifier.");
    if (allIds.length > 1) ambiguity.push("Document references more than one patient identifier.");

    const facts: EvidenceFact[] = [];
    for (const rule of RULES) {
      for (let p = 0; p < input.pages.length; p++) {
        const page = input.pages[p]!;
        const m = rule.pattern.exec(page);
        if (!m) continue;
        facts.push({
          field: rule.field,
          normalizedValue: rule.normalize(m),
          sourcePage: p + 1,
          sourceStart: m.index,
          sourceEnd: m.index + m[0].length,
          quote: m[0],
          confidence: 0.99, // rule-match confidence, not a calibrated model probability
        });
        break;
      }
    }

    const start = facts.find((f) => f.field === "therapy_start_date")?.normalizedValue;
    const end = facts.find((f) => f.field === "therapy_end_date")?.normalizedValue;
    if (!start || !end) ambiguity.push("Therapy start or end date not found.");
    else if (String(end) < String(start)) ambiguity.push("Therapy end date precedes start date.");

    if (input.pages.some((pg) => INSTRUCTION_LIKE.test(pg))) {
      ambiguity.push("Instruction-like text found inside the document; it was treated as clinical data and ignored.");
    }

    const blocking = ambiguity.filter((a) => !a.startsWith("Instruction-like"));
    const abstain = !isPtSummary || !patientReferenceFound || blocking.length > 0;
    return {
      documentId: input.documentId,
      patientReferenceFound,
      evidenceType: isPtSummary ? "PHYSICAL_THERAPY_SUMMARY" : "UNKNOWN",
      facts: abstain ? facts.filter(() => patientReferenceFound) : facts,
      ambiguity,
      abstain,
    };
  }
}
