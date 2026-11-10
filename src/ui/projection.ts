/**
 * Read-only staging projection (V3 CH-7). Pure, client-side, no network:
 * it restates what the already-staged tool input will do, using only values
 * the orchestrator computed. It never estimates anything the data lacks.
 */
import type { Run } from "../orchestrator/runTypes";

export type StagingProjection = {
  /** CREATE for a first attempt; CREATE_OR_REPLAY after a failed attempt, since the task may already exist. */
  taskEffect: "CREATE" | "CREATE_OR_REPLAY";
  owner: string;
  dueAt: string;
  draftId: string;
  fromStatus: string;
  toStatus: "EVIDENCE_REVIEW_PENDING";
  draftVersion: number;
  claimLeadCount: number;
  evidenceDocumentId: string;
  evidenceHashShort: string;
  policyVersion: string;
  /** Last moment the check can be staged (run time + age limit), or null if unknown. */
  stageableUntil: string | null;
  finalChecks: string[];
  unchanged: string[];
};

const QUEUE_LABEL: Record<string, string> = { "pa-specialist-queue": "PA specialist queue" };

export function projectStaging(run: Run, maxRunAgeHours: number | null): StagingProjection | null {
  const input = run.stagedToolInput;
  if (!input) return null;
  if (run.status !== "AWAITING_CONFIRMATION" && run.status !== "FAILED_RETRYABLE") return null;
  const created = Date.parse(run.createdAt);
  return {
    taskEffect: run.status === "FAILED_RETRYABLE" ? "CREATE_OR_REPLAY" : "CREATE",
    owner: QUEUE_LABEL[input.reviewerQueue] ?? input.reviewerQueue,
    dueAt: input.dueAt,
    draftId: input.draftId,
    fromStatus: run.context?.draft.businessStatus ?? "DRAFT_INCOMPLETE",
    toStatus: "EVIDENCE_REVIEW_PENDING",
    draftVersion: input.expectedDraftVersion,
    claimLeadCount: input.claimLeadIds.length,
    evidenceDocumentId: input.evidenceDocumentId,
    evidenceHashShort: input.evidenceDocumentHash.slice(0, 12),
    policyVersion: input.policyVersion,
    stageableUntil: maxRunAgeHours !== null && Number.isFinite(created) ? new Date(created + maxRunAgeHours * 3600_000).toISOString() : null,
    finalChecks: [
      "Provider Access is still permitted (attribution and opt-out)",
      "This check is not older than the time limit",
      `Draft is still version ${input.expectedDraftVersion} with policy ${input.policyVersion}`,
    ],
    unchanged: ["Clinical chart", "Payer (nothing is submitted)", `Draft version stays ${input.expectedDraftVersion}`],
  };
}
