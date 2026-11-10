/**
 * Deterministic integrity checks: hashing, canonical JSON, citation
 * verification, prohibited-content scanning. Server-side only.
 */
import { createHash } from "node:crypto";
import {
  EvidenceExtractionSchema,
  PROHIBITED_OUTPUT_KEYS,
  type EvidenceExtraction,
  type EvidenceFact,
} from "./contracts";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Stable JSON with sorted keys so hashes are reproducible. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Pages are separated by form feed in the synthetic Binary payloads. */
export function splitPages(text: string): string[] {
  return text.split("\f");
}

const VERDICT_PATTERNS: RegExp[] = [
  /\bcriteri(on|a)\s+(is\s+|are\s+)?met\b/i,
  /\bmedically\s+necessary\b/i,
  /\bmeets?\s+medical\s+necessity\b/i,
  /\b(approve|approved|approval)\s+(is\s+)?(likely|recommended|expected)\b/i,
  /\b(recommend(ed)?)\s+(cpt|hcpcs|icd-?10)\b/i,
  /\bshould\s+be\s+(approved|denied)\b/i,
];

export type ExtractionValidation =
  | { ok: true; extraction: EvidenceExtraction; issues: [] }
  | { ok: false; extraction: EvidenceExtraction | null; issues: string[] };

/**
 * Runtime schema validation of untrusted agent output, plus scans for
 * prohibited keys anywhere in the object and verdict language in values.
 */
export function validateExtractionOutput(raw: unknown): ExtractionValidation {
  const issues: string[] = [];
  const keys = collectKeys(raw);
  for (const k of keys) {
    if ((PROHIBITED_OUTPUT_KEYS as readonly string[]).some((p) => p.toLowerCase() === k.toLowerCase())) {
      issues.push(`prohibited key in agent output: ${k}`);
    }
  }
  const parsed = EvidenceExtractionSchema.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) issues.push(`schema: ${i.path.join(".") || "(root)"} ${i.message}`);
    return { ok: false, extraction: null, issues };
  }
  for (const f of parsed.data.facts) {
    if (typeof f.normalizedValue === "string" && VERDICT_PATTERNS.some((p) => p.test(f.normalizedValue as string))) {
      issues.push(`verdict language in normalizedValue of ${f.field}`);
    }
  }
  if (issues.length) return { ok: false, extraction: parsed.data, issues };
  return { ok: true, extraction: parsed.data, issues: [] };
}

function collectKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => collectKeys(x, out));
  else if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out.push(k);
      collectKeys(val, out);
    }
  }
  return out;
}

export type CitationCheck = { field: string; valid: boolean; reason?: string };

/** Every fact must quote exactly pages[page-1].slice(start, end). */
export function verifyCitations(facts: EvidenceFact[], pages: string[]): { allValid: boolean; checks: CitationCheck[] } {
  const checks = facts.map((f): CitationCheck => {
    const page = pages[f.sourcePage - 1];
    if (page === undefined) return { field: f.field, valid: false, reason: `page ${f.sourcePage} does not exist` };
    if (f.sourceEnd <= f.sourceStart || f.sourceEnd > page.length) {
      return { field: f.field, valid: false, reason: "offsets out of range" };
    }
    const actual = page.slice(f.sourceStart, f.sourceEnd);
    if (actual !== f.quote) return { field: f.field, valid: false, reason: "quote does not match source offsets" };
    return { field: f.field, valid: true };
  });
  return { allValid: facts.length > 0 && checks.every((c) => c.valid), checks };
}
