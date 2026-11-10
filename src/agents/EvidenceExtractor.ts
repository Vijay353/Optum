/**
 * Bounded evidence-extraction agent contract (spec §11).
 *
 * The extractor receives untrusted document pages as DATA and returns facts
 * with exact citations, or abstains. It has no tool access, no network
 * access to clinical systems, and no ability to change policy. Its output is
 * runtime-validated by validateExtractionOutput() before anything uses it.
 */
import type { EvidenceExtraction, EvidenceExtractionInput } from "../domain/contracts";

export interface EvidenceExtractor {
  readonly kind: "fixture" | "llm";
  extract(input: EvidenceExtractionInput): Promise<EvidenceExtraction>;
}

/** Lines that look like instructions to an automated system. Flagged, never followed. */
export const INSTRUCTION_LIKE = /(ignore (all )?(previous|prior) instructions|note to automated systems|system prompt|criterionMet\s*=|submit (this|the) (prior )?authori[sz]ation)/i;
