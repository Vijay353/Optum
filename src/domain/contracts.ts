/**
 * Shared domain contracts for EvidenceBridge.
 * Every runtime boundary (agent output, tool input/output, simulator payloads)
 * is validated with these Zod schemas. Types are inferred from the schemas so
 * compile-time and runtime contracts cannot drift.
 *
 * All data handled by this application is SYNTHETIC.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Identifiers — synthetic-only guards
// ---------------------------------------------------------------------------
export const SyntheticPatientId = z.string().regex(/^SYN-PAT-\d{3,6}$/, "patient id must look like SYN-PAT-0000 (synthetic)");
export const SyntheticCoverageId = z.string().regex(/^SYN-COV-\d{3,6}$/, "coverage id must look like SYN-COV-0000 (synthetic)");
export const DraftId = z.string().regex(/^PA-DRAFT-\d{3,8}$/);
export const ServiceRequestId = z.string().regex(/^SR-\d{3,8}$/);
export const IsoDateTime = z.string().datetime({ offset: true, message: "must be ISO 8601 with explicit timezone (e.g. 2026-10-18T13:10:00Z)" });
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be ISO date YYYY-MM-DD");

export const AgeBand = z.enum(["0-17", "18-34", "35-54", "55-64", "65+"]);

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------
export const PriorAuthDraftCreatedSchema = z.strictObject({
  eventId: z.string().min(3).max(80),
  draftId: DraftId,
  draftVersion: z.number().int().positive(),
  serviceRequestId: ServiceRequestId,
  patientId: SyntheticPatientId,
  coverageId: SyntheticCoverageId,
  occurredAt: IsoDateTime,
});
export type PriorAuthDraftCreated = z.infer<typeof PriorAuthDraftCreatedSchema>;

// ---------------------------------------------------------------------------
// Requirement codes (single requirement in this slice)
// ---------------------------------------------------------------------------
export const MISSING_REQUIREMENT_CODE = "SUPERVISED_PHYSICAL_THERAPY_DOCUMENTATION" as const;
export const RequirementCode = z.literal(MISSING_REQUIREMENT_CODE);

// ---------------------------------------------------------------------------
// Draft states
// ---------------------------------------------------------------------------
export const DraftBusinessStatus = z.enum([
  "DRAFT_INCOMPLETE",
  "EVIDENCE_REVIEW_PENDING",
]);
export type DraftBusinessStatus = z.infer<typeof DraftBusinessStatus>;

/** Workflow outcome states (spec §14). Only EVIDENCE_REVIEW_PENDING mutates the draft. */
export const WorkflowOutcomeState = z.enum([
  "EVIDENCE_REVIEW_PENDING",
  "CLAIM_SOURCE_FOLLOWUP",
  "SOURCE_UNAVAILABLE",
  "ACCESS_NOT_PERMITTED",
  "MANUAL_REVIEW",
  "REEVALUATION_REQUIRED",
]);
export type WorkflowOutcomeState = z.infer<typeof WorkflowOutcomeState>;

// ---------------------------------------------------------------------------
// Evidence extraction (agent output contract — spec §11)
// ---------------------------------------------------------------------------
export const ExtractionField = z.enum([
  "therapy_start_date",
  "therapy_end_date",
  "documented_visit_count",
  "supervision_statement",
  "discharge_outcome",
]);
export type ExtractionField = z.infer<typeof ExtractionField>;

export const EvidenceFactSchema = z.strictObject({
  field: ExtractionField,
  normalizedValue: z.union([z.string().max(500), z.number(), z.null()]),
  sourcePage: z.number().int().min(1),
  sourceStart: z.number().int().min(0),
  sourceEnd: z.number().int().min(1),
  quote: z.string().min(1).max(600),
  confidence: z.number().min(0).max(1),
});
export type EvidenceFact = z.infer<typeof EvidenceFactSchema>;

/**
 * strictObject => any additional key (criterionMet, medicallyNecessary,
 * approve, deny, diagnosis, recommendedCpt, attestation, submission payload,
 * approvalLikelihood, ...) fails validation. The prohibited-content check
 * below additionally scans string values for verdict language.
 */
export const EvidenceExtractionSchema = z.strictObject({
  documentId: z.string().min(1),
  patientReferenceFound: z.boolean(),
  evidenceType: z.enum(["PHYSICAL_THERAPY_SUMMARY", "OTHER", "UNKNOWN"]),
  facts: z.array(EvidenceFactSchema).max(20),
  ambiguity: z.array(z.string().max(300)).max(20),
  abstain: z.boolean(),
});
export type EvidenceExtraction = z.infer<typeof EvidenceExtractionSchema>;

export type EvidenceExtractionInput = {
  documentId: string;
  /** Pages of untrusted clinical text. Treated strictly as data. */
  pages: string[];
  expectedPatientId: string;
  requirementCode: typeof MISSING_REQUIREMENT_CODE;
};

/** Keys that must never appear anywhere in agent output (defence in depth beyond strictObject). */
export const PROHIBITED_OUTPUT_KEYS = [
  "criterionMet",
  "medicallyNecessary",
  "medicalNecessity",
  "approve",
  "approved",
  "deny",
  "denied",
  "diagnosis",
  "contraindication",
  "recommendedCpt",
  "recommendedCode",
  "cpt",
  "hcpcs",
  "icd10",
  "modifier",
  "attestation",
  "clinicianStatement",
  "submission",
  "submitPayload",
  "approvalLikelihood",
  "reimbursement",
] as const;

// ---------------------------------------------------------------------------
// Policy (spec §12)
// ---------------------------------------------------------------------------
export const EvidenceDecision = z.enum([
  "REVIEW_EXTERNAL_EVIDENCE",
  "CLAIM_LEAD_ONLY",
  "INSUFFICIENT_EVIDENCE",
  "SOURCE_UNAVAILABLE",
  "MANUAL_REVIEW",
]);
export type EvidenceDecision = z.infer<typeof EvidenceDecision>;

/** Access-gate result named in spec Example E. Kept separate from EvidenceDecision. */
export type GateDecision = EvidenceDecision | "ACCESS_NOT_PERMITTED";

export type PatientMatch = "EXACT" | "AMBIGUOUS" | "NONE";

export type EvidencePolicyInput = {
  patientMatch: PatientMatch;
  providerAttributed: boolean;
  patientOptedOut: boolean;
  policyVersionMatches: boolean;
  draftVersionMatches: boolean;
  claimLeadCount: number;
  clinicalDocumentFound: boolean;
  documentHashVerified: boolean;
  citationsValid: boolean;
  evidenceWithinLookback: boolean;
  agentAbstained: boolean;
  /** Not in the original spec type: an upstream source failed (timeout/5xx/429 exhausted). */
  sourceUnavailable?: boolean;
  /** V3 CH-6 (EVID-1.1): other HIE documents of the same type, from the same author, covering the same period. */
  otherCandidateDocumentCount?: number;
};

/** EVID-1.1 = EVID-1.0 plus rule R5_MULTIPLE_CANDIDATES (V3 CH-6). */
export const POLICY_ENGINE_VERSION = "EVID-1.1" as const;

export type PolicyResult = {
  decision: GateDecision;
  outcomeState: WorkflowOutcomeState;
  createsTask: boolean;
  ruleId: string;
  reasons: string[];
  policyVersion: typeof POLICY_ENGINE_VERSION;
};

// ---------------------------------------------------------------------------
// Tool contract (spec §13)
// ---------------------------------------------------------------------------
export const CreateEvidenceReviewTaskInputSchema = z.strictObject({
  idempotencyKey: z.string().min(16).max(200),
  expectedDraftVersion: z.number().int().positive(),
  draftId: DraftId,
  serviceRequestId: ServiceRequestId,
  syntheticPatientId: SyntheticPatientId,
  missingRequirementCode: RequirementCode,
  policyVersion: z.string().min(1).max(60),
  claimLeadIds: z.array(z.string().min(1)).max(100),
  evidenceDocumentId: z.string().min(1),
  evidenceDocumentHash: z.string().regex(/^[a-f0-9]{64}$/, "sha256 hex"),
  extractionHash: z.string().regex(/^[a-f0-9]{64}$/, "sha256 hex"),
  reviewerQueue: z.literal("pa-specialist-queue"),
  dueAt: IsoDateTime,
});
export type CreateEvidenceReviewTaskInput = z.infer<typeof CreateEvidenceReviewTaskInputSchema>;

export const CreateEvidenceReviewTaskResultSchema = z.strictObject({
  taskId: z.string(),
  status: z.literal("requested"),
  businessStatus: z.literal("EVIDENCE_REVIEW_PENDING"),
  duplicate: z.boolean(),
  draftVersion: z.number().int().positive(),
  chartMutationPerformed: z.literal(false),
  payerSubmissionPerformed: z.literal(false),
});
export type CreateEvidenceReviewTaskResult = z.infer<typeof CreateEvidenceReviewTaskResultSchema>;

// ---------------------------------------------------------------------------
// FHIR-like Task as stored by the mock EHR
// ---------------------------------------------------------------------------
export const FhirTaskSchema = z.object({
  resourceType: z.literal("Task"),
  id: z.string(),
  status: z.literal("requested"),
  businessStatus: z.object({ text: z.literal("EVIDENCE_REVIEW_PENDING") }),
  intent: z.literal("order"),
  code: z.object({ text: z.literal("Review external evidence before prior-authorization submission") }),
  focus: z.object({ reference: z.string() }),
  for: z.object({ reference: z.string() }),
  owner: z.object({ reference: z.string() }),
  authoredOn: z.string(),
  restriction: z.object({ period: z.object({ end: z.string() }) }),
  input: z.array(z.object({ type: z.object({ text: z.string() }), valueString: z.string() })),
  meta: z.object({ versionId: z.string(), lastUpdated: z.string() }),
});
export type FhirTask = z.infer<typeof FhirTaskSchema>;

export const REVIEWER_QUEUE = "pa-specialist-queue" as const;
export const SYNTHETIC_POLICY_ID = "SYN-SPINE-PA-2026-10" as const;
