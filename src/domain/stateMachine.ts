/**
 * Draft state machine (spec §14).
 * The only persisted draft transition in this slice is
 * DRAFT_INCOMPLETE → EVIDENCE_REVIEW_PENDING. All other branches are
 * workflow outcomes recorded on the execution run; the draft is unchanged.
 */
import type { DraftBusinessStatus, GateDecision, WorkflowOutcomeState } from "./contracts";

const ALLOWED: Record<DraftBusinessStatus, DraftBusinessStatus[]> = {
  DRAFT_INCOMPLETE: ["EVIDENCE_REVIEW_PENDING"],
  EVIDENCE_REVIEW_PENDING: [],
};

export function canTransition(from: DraftBusinessStatus, to: DraftBusinessStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: DraftBusinessStatus, to: DraftBusinessStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export class InvalidTransitionError extends Error {
  constructor(public readonly from: string, public readonly to: string) {
    super(`Invalid draft transition ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export const OUTCOME_LABEL: Record<WorkflowOutcomeState, string> = {
  EVIDENCE_REVIEW_PENDING: "Evidence review pending",
  CLAIM_SOURCE_FOLLOWUP: "Follow up with claim source",
  SOURCE_UNAVAILABLE: "External source unavailable",
  ACCESS_NOT_PERMITTED: "External access not permitted",
  MANUAL_REVIEW: "Manual review required",
  REEVALUATION_REQUIRED: "Re-evaluation required",
};

export function draftMutatingDecision(decision: GateDecision): boolean {
  return decision === "REVIEW_EXTERNAL_EVIDENCE";
}
