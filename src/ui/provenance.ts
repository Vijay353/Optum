/**
 * Policy provenance (V3 CH-16). Shows only what is persisted. The synthetic
 * policy service does not record who changed a policy or when, so that is
 * stated as unavailable rather than invented.
 */
import type { Run } from "../orchestrator/runTypes";

export type ProvenanceRow = { label: string; value: string };

export function policyProvenance(run: Run): ProvenanceRow[] | null {
  const p = run.context?.policy;
  if (!p) return null;
  const notRecorded = "Not recorded for this check";
  return [
    { label: "Policy version", value: `${p.policyVersion} (${p.status})` },
    { label: "Effective", value: p.effectiveFrom ? `${p.effectiveFrom} to ${p.effectiveTo ?? "no end date"}` : notRecorded },
    { label: "Checklist items in this version", value: p.requirementCount !== undefined ? String(p.requirementCount) : notRecorded },
    { label: "Lookback for this item", value: `${p.lookbackMonths} months` },
    { label: "Decision rules", value: run.policyResult?.policyVersion ?? "Not evaluated" },
    { label: "Last changed by and when", value: "Provenance unavailable: the policy service does not record this" },
  ];
}
