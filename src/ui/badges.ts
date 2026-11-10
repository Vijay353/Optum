/**
 * Source-labelled status badges (V3 CH-12). External values and
 * EvidenceBridge's own checks are separate badges and never merged.
 * "Unknown" (no value from the source) is distinct from a negative value.
 */
import type { Run } from "../orchestrator/runTypes";

export type Badge = { source: string; label: string; value: string; tone: "ok" | "warn" | "bad" | "unknown" };

export function statusBadges(run: Run): Badge[] {
  const access: Badge = !run.access
    ? { source: "Payer (Provider Access)", label: "Access", value: "Not checked", tone: "unknown" }
    : run.access.decision === "PERMIT"
      ? { source: "Payer (Provider Access)", label: "Access", value: "Permitted", tone: "ok" }
      : { source: "Payer (Provider Access)", label: "Access", value: "Not permitted", tone: "bad" };
  const mpi: Badge = !run.document
    ? { source: "HIE", label: "Index match", value: "Unknown", tone: "unknown" }
    : run.document.mpiMatchConfidence === "exact"
      ? { source: "HIE", label: "Index match", value: "Exact", tone: "ok" }
      : { source: "HIE", label: "Index match", value: "Probable only", tone: "warn" };
  const own: Badge = !run.patientMatch
    ? { source: "EvidenceBridge check", label: "Patient match", value: "Not evaluated", tone: "unknown" }
    : { source: "EvidenceBridge check", label: "Patient match", value: { EXACT: "Exact", AMBIGUOUS: "Ambiguous", NONE: "No match" }[run.patientMatch.match], tone: run.patientMatch.match === "EXACT" ? "ok" : run.patientMatch.match === "AMBIGUOUS" ? "warn" : "bad" };
  const hash: Badge = !run.document
    ? { source: "EvidenceBridge check", label: "Document hash", value: "Not evaluated", tone: "unknown" }
    : run.document.hashVerified
      ? { source: "EvidenceBridge check", label: "Document hash", value: "Verified", tone: "ok" }
      : { source: "EvidenceBridge check", label: "Document hash", value: run.document.declaredSha256 ? "Mismatch" : "No hash from source", tone: "bad" };
  return [access, mpi, own, hash];
}
