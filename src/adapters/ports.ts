/**
 * Domain-oriented ports. The orchestrator depends only on these interfaces;
 * SIMULATED adapters talk HTTP to the local simulators, SANDBOX/LIVE adapters
 * (src/adapters/production) would talk to real systems.
 */
import type { CreateEvidenceReviewTaskInput, CreateEvidenceReviewTaskResult, FhirTask, PriorAuthDraftCreated } from "../domain/contracts";
import type { HttpCallRecord } from "./http";

export type DraftView = {
  id: string; version: number; serviceRequestId: string; patientId: string; coverageId: string;
  policyVersion: string; businessStatus: "DRAFT_INCOMPLETE" | "EVIDENCE_REVIEW_PENDING"; updatedAt: string;
};
export type ServiceRequestView = { id: string; patientId: string; coverageId: string; description: string; serviceCategory: string; orderingOrgId: string };
export type CoverageView = { id: string; patientId: string; planName: string; planType: string };
export type PatientView = { id: string; ageBand: string };
export type LocalDocumentView = { id: string; type: string; title: string; date: string };

export type AccessAuthorization = {
  patientId: string; providerOrgId: string; attributed: boolean; treatmentRelationship: string;
  optedOut: boolean; decision: "PERMIT" | "DENY"; reasons: string[];
};
export type ClaimLead = {
  id: string; serviceDate: string; providerOrgId: string; providerName: string; code: string; codeDisplay: string; outcome: string;
};
export type ExternalDocumentView = {
  id: string; patientRef: string; mpiMatchConfidence: "exact" | "probable"; authorOrgId: string; authorName: string;
  type: string; title: string; date: string; periodStart: string; periodEnd: string; binaryRef: string; declaredSha256: string;
};
export type PolicyView = {
  policyVersion: string; status: "active" | "retired"; label: string; effectiveFrom: string; effectiveTo: string | null;
  requirements: Array<{ code: string; description: string; localDocumentTypes: string[]; externalDocumentTypes: string[]; lookbackMonths: number }>;
};

export type CallHook = { onCall?: (rec: HttpCallRecord) => void };

export interface EhrPort extends CallHook {
  emitDraftCreated(draftId: string): Promise<{ event: PriorAuthDraftCreated; deliveryCount: number }>;
  getDraft(id: string): Promise<DraftView>;
  getServiceRequest(id: string): Promise<ServiceRequestView>;
  getCoverage(id: string): Promise<CoverageView>;
  getPatient(id: string): Promise<PatientView>;
  listLocalDocuments(patientId: string): Promise<LocalDocumentView[]>;
  createEvidenceReviewTask(input: CreateEvidenceReviewTaskInput): Promise<CreateEvidenceReviewTaskResult>;
  readTask(taskId: string): Promise<FhirTask>;
  listTasksForDraft(draftId: string): Promise<FhirTask[]>;
}

export interface ProviderAccessPort extends CallHook {
  checkAuthorization(patientId: string, providerOrgId: string, asOf: string): Promise<AccessAuthorization>;
  listClaims(patientId: string, providerOrgId: string, asOf: string): Promise<ClaimLead[]>;
}

export interface HiePort extends CallHook {
  searchDocuments(q: { patientId: string; authorOrgId?: string; type?: string; periodFrom?: string; periodTo?: string }): Promise<ExternalDocumentView[]>;
  getBinary(binaryRef: string): Promise<string>;
}

export interface PolicyPort extends CallHook {
  getPolicy(policyVersion: string): Promise<PolicyView>;
}

/**
 * SIMULATED-only probe (V3 CH-1). Lets the read-back prove that no write
 * request reached the payer during a run. Real payers expose nothing like
 * this, so SANDBOX/LIVE modes leave it undefined and the check is reported
 * as not evaluated.
 */
export interface SimulatorProbePort extends CallHook {
  countPayerWriteRequestsSince(sinceIso: string): Promise<number>;
}

export type Adapters = { ehr: EhrPort; payer: ProviderAccessPort; hie: HiePort; policy: PolicyPort; probe?: SimulatorProbePort };
