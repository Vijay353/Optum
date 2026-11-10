/**
 * SANDBOX / LIVE adapter skeletons — Status: NOT_IMPLEMENTED / NOT_VERIFIED.
 *
 * They compile against the same ports as the simulators and FAIL CLOSED.
 * They never fall back to simulated data. Real endpoint paths, auth flows
 * (SMART Backend Services, mTLS, payer-specific OAuth) and payload profiles
 * are TO_VERIFY per payer/HIE/EHR — see docs/INTEGRATIONS.md.
 */
import type { CreateEvidenceReviewTaskInput, CreateEvidenceReviewTaskResult, FhirTask, PriorAuthDraftCreated } from "../../domain/contracts";
import type {
  AccessAuthorization, ClaimLead, CoverageView, DraftView, EhrPort, ExternalDocumentView, HiePort, LocalDocumentView,
  PatientView, PolicyPort, PolicyView, ProviderAccessPort, ServiceRequestView,
} from "../ports";

export class ProviderNotConfiguredError extends Error {
  constructor(adapter: string, detail: string) {
    super(`${adapter} is not configured or not verified: ${detail}. Switch EB_MODE=SIMULATED to use local simulators.`);
    this.name = "ProviderNotConfiguredError";
  }
}

const notVerified = (adapter: string): never => {
  throw new ProviderNotConfiguredError(adapter, "TO_VERIFY — real contract not implemented");
};

export class FhirEhrAdapter implements EhrPort {
  onCall?: undefined;
  constructor(cfg: { baseUrl?: string; clientId?: string; clientSecret?: string }) {
    if (!cfg.baseUrl || !cfg.clientId || !cfg.clientSecret) throw new ProviderNotConfiguredError("FhirEhrAdapter", "missing base URL or SMART backend credentials");
  }
  emitDraftCreated(_draftId: string): Promise<{ event: PriorAuthDraftCreated; deliveryCount: number }> { return notVerified("FhirEhrAdapter.emitDraftCreated"); }
  getDraft(_id: string): Promise<DraftView> { return notVerified("FhirEhrAdapter.getDraft"); }
  getServiceRequest(_id: string): Promise<ServiceRequestView> { return notVerified("FhirEhrAdapter.getServiceRequest"); }
  getCoverage(_id: string): Promise<CoverageView> { return notVerified("FhirEhrAdapter.getCoverage"); }
  getPatient(_id: string): Promise<PatientView> { return notVerified("FhirEhrAdapter.getPatient"); }
  listLocalDocuments(_p: string): Promise<LocalDocumentView[]> { return notVerified("FhirEhrAdapter.listLocalDocuments"); }
  createEvidenceReviewTask(_i: CreateEvidenceReviewTaskInput): Promise<CreateEvidenceReviewTaskResult> { return notVerified("FhirEhrAdapter.createEvidenceReviewTask"); }
  readTask(_id: string): Promise<FhirTask> { return notVerified("FhirEhrAdapter.readTask"); }
  listTasksForDraft(_d: string): Promise<FhirTask[]> { return notVerified("FhirEhrAdapter.listTasksForDraft"); }
}

export class PayerProviderAccessAdapter implements ProviderAccessPort {
  onCall?: undefined;
  constructor(cfg: { baseUrl?: string; clientId?: string; clientSecret?: string }) {
    if (!cfg.baseUrl || !cfg.clientId || !cfg.clientSecret) throw new ProviderNotConfiguredError("PayerProviderAccessAdapter", "missing Provider Access base URL or credentials");
  }
  checkAuthorization(_p: string, _o: string, _a: string): Promise<AccessAuthorization> { return notVerified("PayerProviderAccessAdapter.checkAuthorization"); }
  listClaims(_p: string, _o: string, _a: string): Promise<ClaimLead[]> { return notVerified("PayerProviderAccessAdapter.listClaims"); }
}

export class HieFhirAdapter implements HiePort {
  onCall?: undefined;
  constructor(cfg: { baseUrl?: string }) {
    if (!cfg.baseUrl) throw new ProviderNotConfiguredError("HieFhirAdapter", "missing HIE base URL / trust framework credentials");
  }
  searchDocuments(_q: { patientId: string }): Promise<ExternalDocumentView[]> { return notVerified("HieFhirAdapter.searchDocuments"); }
  getBinary(_r: string): Promise<string> { return notVerified("HieFhirAdapter.getBinary"); }
}

/** Seam for licensed criteria content. Never ships proprietary criteria. */
export class LicensedCriteriaPolicyAdapter implements PolicyPort {
  onCall?: undefined;
  constructor() {
    throw new ProviderNotConfiguredError("LicensedCriteriaPolicyAdapter", "requires a criteria license and vendor integration agreement");
  }
  getPolicy(_v: string): Promise<PolicyView> { return notVerified("LicensedCriteriaPolicyAdapter.getPolicy"); }
}
