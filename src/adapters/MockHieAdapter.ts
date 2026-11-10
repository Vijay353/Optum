import { HttpClient, type HttpCallRecord, type HttpClientOptions } from "./http";
import type { ExternalDocumentView, HiePort } from "./ports";
import { HieDocBundleWire } from "./wireSchemas";

/** SIMULATED-mode HIE adapter. Bodies are schema-validated (V3 CH-2). */
export class MockHieAdapter implements HiePort {
  private readonly http: HttpClient;
  constructor(opts: Omit<HttpClientOptions, "system">) {
    this.http = new HttpClient({ ...opts, system: "mock-hie" });
  }
  set onCall(fn: ((rec: HttpCallRecord) => void) | undefined) {
    this.http.onCall = fn;
  }
  async searchDocuments(q: { patientId: string; authorOrgId?: string; type?: string; periodFrom?: string; periodTo?: string }): Promise<ExternalDocumentView[]> {
    const b = (await this.http.requestParsed("GET", "fhir/DocumentReference", HieDocBundleWire, {
      query: { patient: q.patientId, author: q.authorOrgId, type: q.type, "period-start-ge": q.periodFrom, "period-end-le": q.periodTo },
    })).body;
    return (b.entry ?? []).map(({ resource: d }) => {
      const mpi = d.extension.find((e) => e.url.endsWith("mpi-match-confidence"))?.valueCode;
      return {
        id: d.id,
        patientRef: d.subject.reference,
        // Only an explicit "exact" counts as exact. Anything else, including absent, is treated as probable (leads to AMBIGUOUS).
        mpiMatchConfidence: mpi === "exact" ? "exact" : "probable",
        authorOrgId: d.author[0]!.reference.split("/").pop()!,
        authorName: d.author[0]!.display,
        type: d.type.text,
        title: d.description,
        date: d.date,
        periodStart: d.context.period.start,
        periodEnd: d.context.period.end,
        binaryRef: d.content[0]!.attachment.url,
        // An absent hash is a provenance failure the policy handles (hashVerified=false → MANUAL_REVIEW), not a default pass.
        declaredSha256: d.extension.find((e) => e.url.endsWith("payload-sha256"))?.valueString ?? "",
      };
    });
  }
  async getBinary(binaryRef: string): Promise<string> {
    return (await this.http.request<string>("GET", binaryRef, { parse: "text" })).body;
  }
}
