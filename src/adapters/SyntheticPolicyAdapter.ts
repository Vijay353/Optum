import { HttpClient, type HttpCallRecord, type HttpClientOptions } from "./http";
import type { PolicyPort, PolicyView } from "./ports";
import { PolicyWire } from "./wireSchemas";

/**
 * Synthetic policy adapter. Production seam: a LicensedCriteriaAdapter
 * implementing PolicyPort would wrap licensed criteria content under contract.
 * This prototype never reproduces or implies access to InterQual logic.
 */
export class SyntheticPolicyAdapter implements PolicyPort {
  private readonly http: HttpClient;
  constructor(opts: Omit<HttpClientOptions, "system">) {
    this.http = new HttpClient({ ...opts, system: "synthetic-policy" });
  }
  set onCall(fn: ((rec: HttpCallRecord) => void) | undefined) {
    this.http.onCall = fn;
  }
  async getPolicy(policyVersion: string): Promise<PolicyView> {
    return (await this.http.requestParsed("GET", `policies/${policyVersion}`, PolicyWire)).body;
  }
}
