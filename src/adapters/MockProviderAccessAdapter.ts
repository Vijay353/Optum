import { HttpClient, type HttpCallRecord, type HttpClientOptions } from "./http";
import type { AccessAuthorization, ClaimLead, ProviderAccessPort } from "./ports";
import { AccessAuthorizationWire, EobBundleWire } from "./wireSchemas";

/** SIMULATED-mode Provider Access adapter (mock future CMS-0057-F API). Bodies are schema-validated (V3 CH-2). */
export class MockProviderAccessAdapter implements ProviderAccessPort {
  private readonly http: HttpClient;
  constructor(opts: Omit<HttpClientOptions, "system">) {
    this.http = new HttpClient({ ...opts, system: "mock-provider-access" });
  }
  set onCall(fn: ((rec: HttpCallRecord) => void) | undefined) {
    this.http.onCall = fn;
  }
  async checkAuthorization(patientId: string, providerOrgId: string, asOf: string): Promise<AccessAuthorization> {
    return (await this.http.requestParsed("GET", `access/${patientId}/authorization`, AccessAuthorizationWire, { query: { provider: providerOrgId, asOf } })).body;
  }
  async listClaims(patientId: string, providerOrgId: string, asOf: string): Promise<ClaimLead[]> {
    const b = (await this.http.requestParsed("GET", "fhir/ExplanationOfBenefit", EobBundleWire, {
      query: { patient: patientId, asOf },
      headers: { "x-requesting-provider": providerOrgId },
    })).body;
    return (b.entry ?? []).flatMap((e) =>
      e.resource.item.map((it) => ({
        id: e.resource.id,
        serviceDate: it.servicedDate,
        providerOrgId: e.resource.provider.reference.split("/").pop()!,
        providerName: e.resource.provider.display,
        code: it.productOrService.coding[0]!.code,
        codeDisplay: it.productOrService.coding[0]!.display,
        outcome: e.resource.outcome,
      })),
    );
  }
}
