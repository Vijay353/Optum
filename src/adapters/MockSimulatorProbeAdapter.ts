import { HttpClient, type HttpCallRecord, type HttpClientOptions } from "./http";
import type { SimulatorProbePort } from "./ports";
import { WriteCountWire } from "./wireSchemas";

/** SIMULATED-mode probe into the mock payer's own request log (V3 CH-1). */
export class MockSimulatorProbeAdapter implements SimulatorProbePort {
  private readonly http: HttpClient;
  constructor(opts: Omit<HttpClientOptions, "system">) {
    this.http = new HttpClient({ ...opts, system: "mock-provider-access" });
  }
  set onCall(fn: ((rec: HttpCallRecord) => void) | undefined) {
    this.http.onCall = fn;
  }
  async countPayerWriteRequestsSince(sinceIso: string): Promise<number> {
    return (await this.http.requestParsed("GET", "_admin/write-count", WriteCountWire, { query: { since: sinceIso } })).body.writeRequests;
  }
}
