/**
 * Truthful empty states (V3 CH-15). Each one says why the list is empty:
 * nothing matches the filter, nothing exists yet, or it was never requested.
 */
import type { Run } from "../orchestrator/runTypes";

const ENTITY_WORDS: Record<string, string> = {
  tasks: "No review tasks yet. A task appears after a PA specialist stages one.",
  ehr_audit: "No EHR audit entries yet. Entries appear when events are emitted or tasks are written.",
};

export function recordsEmptyText(entity: string, total: number, query: string): string | null {
  if (total > 0 && query) return `No ${entity} records match "${query}". ${total} record${total === 1 ? "" : "s"} exist without the search.`;
  if (total > 0) return null;
  return ENTITY_WORDS[entity] ?? `No ${entity} records yet. Load a scenario or import a workbook.`;
}

export function claimsEmptyText(run: Run): string | null {
  if (run.claims && run.claims.leadCount > 0) return null;
  if (run.claims) return "Requested, but no claim lines from one clinic fall inside the lookback window.";
  if (run.access && run.access.decision !== "PERMIT") return "Not requested: Provider Access was not permitted.";
  if (run.trace.some((t) => t.step === "SOURCE_UNAVAILABLE")) return "Not available: a source did not respond.";
  return "Not requested: the check stopped before claims were needed.";
}

export function readbackEmptyText(run: Run): string | null {
  if (run.execution.readback) return null;
  if (run.status === "AWAITING_CONFIRMATION") return "Nothing written yet. Read-back runs after staging.";
  if (run.execution.preWriteCheck?.refusal) return "Nothing written: the checks repeated before writing refused it, so there is nothing to read back.";
  if (run.stagedToolInput) return "Nothing read back yet.";
  return "No task for this outcome, so nothing was written or read back.";
}
