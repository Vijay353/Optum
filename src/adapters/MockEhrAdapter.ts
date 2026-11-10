import type { CreateEvidenceReviewTaskInput, CreateEvidenceReviewTaskResult, FhirTask } from "../domain/contracts";
import { CreateEvidenceReviewTaskResultSchema, FhirTaskSchema } from "../domain/contracts";
import { HttpClient, type HttpCallRecord, type HttpClientOptions } from "./http";
import type { CoverageView, DraftView, EhrPort, LocalDocumentView, PatientView, ServiceRequestView } from "./ports";
import { CoverageWire, DraftWire, EmitResultWire, LocalDocBundleWire, PatientWire, ServiceRequestWire } from "./wireSchemas";
import { z } from "zod";

const refId = (ref: string) => ref.split("/").pop() ?? ref;
const TaskBundleWire = z.object({ entry: z.array(z.object({ resource: FhirTaskSchema })).optional() });

/** SIMULATED-mode EHR adapter: FHIR-like HTTP calls into the mock EHR. Every body is schema-validated (V3 CH-2). */
export class MockEhrAdapter implements EhrPort {
  private readonly http: HttpClient;
  private readonly workflow: HttpClient;
  constructor(opts: Omit<HttpClientOptions, "system">, workflowToken: string) {
    this.http = new HttpClient({ ...opts, system: "mock-ehr" });
    this.workflow = new HttpClient({ ...opts, token: workflowToken, system: "mock-ehr" });
  }
  set onCall(fn: ((rec: HttpCallRecord) => void) | undefined) {
    this.http.onCall = fn;
    this.workflow.onCall = fn;
  }

  async emitDraftCreated(draftId: string) {
    return (await this.workflow.requestParsed("POST", `prior-auth-drafts/${draftId}/emit-created`, EmitResultWire, { retry: false })).body;
  }
  async getDraft(id: string): Promise<DraftView> {
    return (await this.http.requestParsed("GET", `prior-auth-drafts/${id}`, DraftWire)).body;
  }
  async getServiceRequest(id: string): Promise<ServiceRequestView> {
    const b = (await this.http.requestParsed("GET", `fhir/ServiceRequest/${id}`, ServiceRequestWire)).body;
    return {
      id: b.id, patientId: refId(b.subject.reference), coverageId: refId(b.insurance[0]!.reference),
      description: b.code.text, serviceCategory: b.category[0]!.text, orderingOrgId: refId(b.requester.reference),
    };
  }
  async getCoverage(id: string): Promise<CoverageView> {
    const b = (await this.http.requestParsed("GET", `fhir/Coverage/${id}`, CoverageWire)).body;
    return { id: b.id, patientId: refId(b.beneficiary.reference), planName: b.class[0]!.name, planType: b.class[0]!.value };
  }
  async getPatient(id: string): Promise<PatientView> {
    const b = (await this.http.requestParsed("GET", `fhir/Patient/${id}`, PatientWire)).body;
    // An absent age band stays "unknown"; patient matching then cannot reach EXACT (it compares age bands).
    return { id: b.id, ageBand: b.extension.find((e) => e.url === "urn:synthetic:age-band")?.valueString ?? "unknown" };
  }
  async listLocalDocuments(patientId: string): Promise<LocalDocumentView[]> {
    const b = (await this.http.requestParsed("GET", "fhir/DocumentReference", LocalDocBundleWire, { query: { patient: patientId } })).body;
    return (b.entry ?? []).map((e) => ({ id: e.resource.id, type: e.resource.type.text, title: e.resource.description, date: e.resource.date }));
  }
  /** Safe to retry: the EHR enforces durable idempotency on the key. */
  async createEvidenceReviewTask(input: CreateEvidenceReviewTaskInput): Promise<CreateEvidenceReviewTaskResult> {
    const r = await this.http.requestParsed("POST", "fhir/Task", CreateEvidenceReviewTaskResultSchema, {
      body: input,
      retry: true,
      headers: { "idempotency-key": input.idempotencyKey, "if-match": `W/"${input.expectedDraftVersion}"` },
    });
    return r.body;
  }
  async listTasksForDraft(draftId: string): Promise<FhirTask[]> {
    const b = (await this.http.requestParsed("GET", "fhir/Task", TaskBundleWire, { query: { draft: draftId } })).body;
    return (b.entry ?? []).map((e) => e.resource);
  }
  async readTask(taskId: string): Promise<FhirTask> {
    return (await this.http.requestParsed("GET", `fhir/Task/${taskId}`, FhirTaskSchema)).body;
  }
}
