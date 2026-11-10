/**
 * createEvidenceReviewTask — the ONE mutating tool in this slice (spec §13).
 *
 * Guards (all deterministic, all enforced here before the EHR is called):
 *  - tool authorization: only an authenticated PA specialist confirmation may trigger it
 *  - policy gate: only a REVIEW_EXTERNAL_EVIDENCE decision may reach it
 *  - runtime schema validation of the input
 * The EHR then enforces scope, durable idempotency, optimistic concurrency,
 * atomic Task + draft-status write and an immutable audit event.
 *
 * The tool has no capability to modify clinical resources or call any payer
 * submission endpoint: the EHR port exposes no such method and the
 * orchestrator's client credentials carry no such scope.
 */
import {
  CreateEvidenceReviewTaskInputSchema,
  type CreateEvidenceReviewTaskInput,
  type CreateEvidenceReviewTaskResult,
  type FhirTask,
  type PolicyResult,
} from "../domain/contracts";
import type { EhrPort } from "../adapters/ports";

export type ToolActor = { userId: string; role: "pa-specialist" | "viewer" | "sim-admin" };

export class ToolAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolAuthorizationError";
  }
}

export const TOOL_ALLOWED_ROLES: ReadonlyArray<ToolActor["role"]> = ["pa-specialist"];

export async function createEvidenceReviewTask(
  ehr: EhrPort,
  input: CreateEvidenceReviewTaskInput,
  ctx: { actor: ToolActor; policy: PolicyResult },
): Promise<CreateEvidenceReviewTaskResult> {
  if (!TOOL_ALLOWED_ROLES.includes(ctx.actor.role)) {
    throw new ToolAuthorizationError(`role ${ctx.actor.role} may not stage evidence review tasks`);
  }
  if (ctx.policy.decision !== "REVIEW_EXTERNAL_EVIDENCE" || !ctx.policy.createsTask) {
    throw new ToolAuthorizationError(`policy decision ${ctx.policy.decision} does not permit task creation`);
  }
  const parsed = CreateEvidenceReviewTaskInputSchema.parse(input);
  return ehr.createEvidenceReviewTask(parsed);
}

export type ReadbackCheck = { name: string; expected: string; actual: string; pass: boolean };

/** Independent read-after-write verification of the Task the EHR persisted. */
export function verifyTaskReadback(task: FhirTask, input: CreateEvidenceReviewTaskInput, result: CreateEvidenceReviewTaskResult): ReadbackCheck[] {
  const inputVal = (name: string) => task.input.find((i) => i.type.text === name)?.valueString ?? "(missing)";
  const c = (name: string, expected: string, actual: string): ReadbackCheck => ({ name, expected, actual, pass: expected === actual });
  return [
    c("task id", result.taskId, task.id),
    c("status", "requested", task.status),
    c("business status", "EVIDENCE_REVIEW_PENDING", task.businessStatus.text),
    c("owner", `CareTeam/${input.reviewerQueue}`, task.owner.reference),
    c("focus", `ServiceRequest/${input.serviceRequestId}`, task.focus.reference),
    c("patient", `Patient/${input.syntheticPatientId}`, task.for.reference),
    c("draft link", `${input.draftId}|v${input.expectedDraftVersion}`, inputVal("draft")),
    c("missing requirement", input.missingRequirementCode, inputVal("missingRequirement")),
    c("policy version", input.policyVersion, inputVal("policyVersion")),
    c("evidence document", `DocumentReference/${input.evidenceDocumentId}`, inputVal("evidenceDocument")),
    c("evidence hash", input.evidenceDocumentHash, inputVal("evidenceDocumentHash")),
    c("extraction hash", input.extractionHash, inputVal("extractionHash")),
    c("claim leads", input.claimLeadIds.map((x) => `ExplanationOfBenefit/${x}`).join(","), inputVal("claimLeads")),
  ];
}
