/**
 * Execution-run record. The UI renders exactly this object (read from the
 * same store the orchestrator writes) — there is no separate UI state.
 * Types only; safe to import from the browser bundle.
 */
import type {
  CreateEvidenceReviewTaskInput,
  CreateEvidenceReviewTaskResult,
  EvidenceExtraction,
  EvidencePolicyInput,
  FhirTask,
  PolicyResult,
  PriorAuthDraftCreated,
  WorkflowOutcomeState,
} from "../domain/contracts";
import type { HttpCallRecord } from "../adapters/http";
import type { AccessAuthorization, ClaimLead, DraftView, ExternalDocumentView, LocalDocumentView } from "../adapters/ports";
import type { PatientMatchResult } from "../domain/patientMatch";
import type { ReadbackCheck } from "../tools/createEvidenceReviewTask";

/** Every run status, in one list so presentation can be tested exhaustively (V3 CH-14). */
export const RUN_STATUSES = [
  "EVALUATING",
  "AWAITING_CONFIRMATION", // decision allows a task; waiting for the PA specialist to stage it
  "NO_ACTION", // decision does not create a task, or the final check stopped the write; draft unchanged
  "NO_GAP", // requirement already present locally
  "EXECUTING",
  "COMPLETED", // task created (or replayed) AND readback verified
  "REEVALUATION_REQUIRED", // stale draft/policy version or a check that is too old; nothing written
  "FAILED_RETRYABLE", // transient failure; safe to retry with the same idempotency key
  "FAILED", // non-retryable failure (e.g. readback mismatch); never shown as success
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type TraceStep = {
  seq: number;
  at: string;
  step: string;
  actor: "event" | "orchestrator" | "policy" | "agent" | "tool" | "verification" | "user";
  ok: boolean;
  summary: string;
  durationMs: number;
  calls: HttpCallRecord[];
  data?: Record<string, unknown>;
};

export type PreWriteCheck = {
  at: string;
  runAgeMinutes: number;
  maxAgeMinutes: number;
  ageOk: boolean;
  access: AccessAuthorization | null;
  accessOk: boolean;
  passed: boolean;
  /** Plain-language reason when the write was refused. */
  refusal: "RUN_TOO_OLD" | "ACCESS_NOT_PERMITTED" | "ACCESS_CHECK_UNAVAILABLE" | null;
};

export type Run = {
  runId: string;
  event: PriorAuthDraftCreated;
  deliveryCount: number;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  context: {
    draft: DraftView;
    serviceRequestDescription: string;
    coveragePlan: string;
    patientAgeBand: string;
    policy: {
      policyVersion: string; status: string; label: string; lookbackMonths: number;
      /** V3 CH-16: persisted provenance fields as returned by the policy service. Absent on older runs. */
      effectiveFrom?: string; effectiveTo?: string | null; requirementCount?: number;
    };
    missingRequirement: { code: string; description: string; localStatus: "MISSING" | "PRESENT" } | null;
    localDocuments: LocalDocumentView[];
  } | null;
  access: AccessAuthorization | null;
  claims: {
    leads: ClaimLead[];
    leadCount: number;
    providerOrgId: string | null;
    providerName: string | null;
    firstDate: string | null;
    lastDate: string | null;
    codes: string[];
  } | null;
  /** V3 CH-6: every candidate document the HIE returned for the lead source and period. Absent on older runs. */
  candidates?: Array<{ id: string; date: string; title: string; periodStart: string; periodEnd: string; declaredSha256: string; selected: boolean; sameContentAsSelected: boolean }>;
  document: (ExternalDocumentView & { computedSha256: string; hashVerified: boolean; pageCount: number }) | null;
  documentPages?: string[]; // returned only to authorized UI callers for citation display; never logged
  patientMatch: PatientMatchResult | null;
  extraction: {
    extractor: "fixture" | "llm";
    output: EvidenceExtraction | null;
    validationIssues: string[];
    citationChecks: Array<{ field: string; valid: boolean; reason?: string }>;
    extractionHash: string | null;
    skippedReason?: string;
  } | null;
  lookback: { windowStart: string; evidenceDate: string | null; within: boolean } | null;
  policyInput: EvidencePolicyInput | null;
  policyResult: PolicyResult | null;
  outcomeState: WorkflowOutcomeState | null;
  stagedToolInput: CreateEvidenceReviewTaskInput | null;
  execution: {
    confirmedBy: string | null;
    toolCalls: number;
    result: CreateEvidenceReviewTaskResult | null;
    error: { kind: string; status: number | null; message: string } | null;
    readback: { task: FhirTask | null; checks: ReadbackCheck[]; draftStatusAfter: string | null; draftVersionAfter: number | null; verified: boolean } | null;
    payerWriteRequests: number | null;
    stateChange: { from: string; to: string; persisted: boolean } | null;
    /** CH-0A: checks repeated immediately before the write. Absent on runs created before CH-0A. */
    preWriteCheck?: PreWriteCheck | null;
  };
  trace: TraceStep[];
  error: string | null;
};
