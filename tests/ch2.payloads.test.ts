/**
 * V3 CH-2: every cross-boundary body is schema-validated before it is read.
 * Malformed bodies become a non-retryable contract error, never default values.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { api, countRows, startTestServer, type TestEnv } from "./helpers";
import { UpstreamError } from "../src/adapters/http";
import { MockEhrAdapter } from "../src/adapters/MockEhrAdapter";
import { MockProviderAccessAdapter } from "../src/adapters/MockProviderAccessAdapter";
import { MockHieAdapter } from "../src/adapters/MockHieAdapter";
import { SyntheticPolicyAdapter } from "../src/adapters/SyntheticPolicyAdapter";
import { conflictCodeOf } from "../src/adapters/wireSchemas";
import { processPriorAuthDraft } from "../src/orchestrator/processPriorAuthDraft";

// A fake upstream that answers each path with whatever body the test sets.
const bodies = new Map<string, unknown>();
let fake: Server;
let fakeUrl = "";
beforeAll(async () => {
  const app = express();
  app.use((req, res) => {
    const key = req.path;
    if (!bodies.has(key)) return void res.status(404).json({});
    res.json(bodies.get(key));
  });
  fake = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => fake.close(() => r())));

let env: TestEnv | undefined;
afterEach(async () => { bodies.clear(); await env?.close(); env = undefined; });

const o = { token: "t", timeoutMs: 500, maxRetries: 2, baseBackoffMs: 5 };
async function expectContract(p: Promise<unknown>, re: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(UpstreamError);
  const u = err as UpstreamError;
  expect(u.kind).toBe("contract");
  expect(u.retryable).toBe(false);
  expect(u.attempts).toBe(1); // a 200 with a bad body is not retried
  expect(u.message).toMatch(re);
}

describe("adapters reject malformed bodies", () => {
  it("EHR draft without a version", async () => {
    bodies.set("/prior-auth-drafts/PA-DRAFT-1", { id: "PA-DRAFT-1", serviceRequestId: "SR-1", patientId: "P", coverageId: "C", policyVersion: "X", businessStatus: "DRAFT_INCOMPLETE", updatedAt: "t" });
    await expectContract(new MockEhrAdapter({ ...o, baseUrl: fakeUrl }, "t").getDraft("PA-DRAFT-1"), /version/);
  });
  it("EHR draft with an unknown status", async () => {
    bodies.set("/prior-auth-drafts/PA-DRAFT-1", { id: "PA-DRAFT-1", version: 3, serviceRequestId: "SR-1", patientId: "P", coverageId: "C", policyVersion: "X", businessStatus: "APPROVED", updatedAt: "t" });
    await expectContract(new MockEhrAdapter({ ...o, baseUrl: fakeUrl }, "t").getDraft("PA-DRAFT-1"), /businessStatus/);
  });
  it("ServiceRequest with no insurance is not turned into an empty coverage id", async () => {
    bodies.set("/fhir/ServiceRequest/SR-1", { id: "SR-1", subject: { reference: "Patient/P" }, insurance: [], code: { text: "x" }, category: [{ text: "c" }], requester: { reference: "Organization/O" } });
    await expectContract(new MockEhrAdapter({ ...o, baseUrl: fakeUrl }, "t").getServiceRequest("SR-1"), /insurance/);
  });
  it("access decision that is neither PERMIT nor DENY", async () => {
    bodies.set("/access/P/authorization", { patientId: "P", providerOrgId: "O", attributed: true, treatmentRelationship: "ESTABLISHED", optedOut: false, decision: "MAYBE", reasons: [] });
    await expectContract(new MockProviderAccessAdapter({ ...o, baseUrl: fakeUrl }).checkAuthorization("P", "O", "2026-10-18"), /decision/);
  });
  it("access answer with opt-out missing is not read as false", async () => {
    bodies.set("/access/P/authorization", { patientId: "P", providerOrgId: "O", attributed: true, treatmentRelationship: "ESTABLISHED", decision: "PERMIT", reasons: [] });
    await expectContract(new MockProviderAccessAdapter({ ...o, baseUrl: fakeUrl }).checkAuthorization("P", "O", "2026-10-18"), /optedOut/);
  });
  it("claim line without a procedure code is not turned into an empty code", async () => {
    bodies.set("/fhir/ExplanationOfBenefit", { entry: [{ resource: { id: "EOB-1", outcome: "complete", provider: { reference: "Organization/O", display: "x" }, item: [{ servicedDate: "2026-01-12", productOrService: { coding: [] } }] } }] });
    await expectContract(new MockProviderAccessAdapter({ ...o, baseUrl: fakeUrl }).listClaims("P", "O", "2026-10-18"), /coding/);
  });
  it("HIE document without content or author", async () => {
    bodies.set("/fhir/DocumentReference", { entry: [{ resource: { id: "HIE-1", type: { text: "t" }, subject: { reference: "Patient/P" }, author: [], description: "d", date: "2026-03-10", context: { period: { start: "a", end: "b" } }, content: [] } }] });
    await expectContract(new MockHieAdapter({ ...o, baseUrl: fakeUrl }).searchDocuments({ patientId: "P" }), /author|content/);
  });
  it("policy label that is not marked SYNTHETIC", async () => {
    bodies.set("/policies/X", { policyVersion: "X", status: "active", label: "InterQual criteria", effectiveFrom: "2026-10-01", effectiveTo: null, requirements: [{ code: "C", description: "", localDocumentTypes: [], externalDocumentTypes: [], lookbackMonths: 12 }] });
    await expectContract(new SyntheticPolicyAdapter({ ...o, baseUrl: fakeUrl }).getPolicy("X"), /label/);
  });
  it("HIE document with an absent hash maps to an unverifiable hash, not a pass", async () => {
    bodies.set("/fhir/DocumentReference", { entry: [{ resource: { id: "HIE-1", type: { text: "t" }, subject: { reference: "Patient/P" }, author: [{ reference: "Organization/O", display: "x" }], description: "d", date: "2026-03-10", context: { period: { start: "a", end: "b" } }, content: [{ attachment: { url: "Binary/B" } }] } }] });
    const [d] = await new MockHieAdapter({ ...o, baseUrl: fakeUrl }).searchDocuments({ patientId: "P" });
    expect(d?.declaredSha256).toBe("");
    expect(d?.mpiMatchConfidence).toBe("probable");
  });
});

describe("conflict accessor", () => {
  it("only a well-formed 409 body counts as a version conflict", () => {
    expect(conflictCodeOf({ code: "VERSION_CONFLICT", currentVersion: 4 })).toBe("VERSION_CONFLICT");
    expect(conflictCodeOf({ code: "VERSION_CONFLICT" })).toBe("VERSION_CONFLICT");
    expect(conflictCodeOf({ code: 5 })).toBeNull();
    expect(conflictCodeOf("VERSION_CONFLICT")).toBeNull();
    expect(conflictCodeOf(null)).toBeNull();
  });
});

describe("orchestrator handling", () => {
  it("a malformed access answer fails the run before any claims or HIE request, and writes nothing", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    bodies.set("/access/SYN-PAT-1042/authorization", { decision: "PERMIT" });
    const base = env.handle.deps();
    const deps = {
      ...base,
      makeAdapters: (onCall: Parameters<typeof base.makeAdapters>[0]) => {
        const a = base.makeAdapters(onCall);
        const payer = new MockProviderAccessAdapter({ ...o, baseUrl: fakeUrl });
        payer.onCall = onCall;
        return { ...a, payer };
      },
    };
    const emit = await (await fetch(`${env.baseUrl}/mock-ehr/prior-auth-drafts/PA-DRAFT-99412/emit-created`, { method: "POST", headers: { authorization: "Bearer eb-ehr-workflow-local" } })).json();
    const run = await processPriorAuthDraft(deps, emit.event);
    expect(run.status).toBe("FAILED");
    expect(run.error).toMatch(/unexpected body/);
    expect(run.claims).toBeNull();
    expect(run.stagedToolInput).toBeNull();
    expect(countRows(env.db, "hie_access_log")).toBe(0);
    expect(countRows(env.db, "ehr_tasks")).toBe(0);
  });

  it("valid simulator bodies still give the same primary result", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const c = (await api<{ run: { policyResult: { decision: string } } }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    expect(c.policyResult.decision).toBe("REVIEW_EXTERNAL_EVIDENCE");
  });

  it("fault control rejects malformed configs", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    expect((await api(env, "PUT", "/api/faults/payer.eob", { kind: "explode" })).status).toBe(400);
    expect((await api(env, "PUT", "/api/faults/payer.eob", { kind: "status", status: 200 })).status).toBe(400);
    expect((await api(env, "PUT", "/api/faults/nope", { kind: "status", status: 503 })).status).toBe(400);
    expect((await api(env, "PUT", "/api/faults/payer.eob", { kind: "status", status: 503, remaining: 1 })).status).toBe(200);
  });
});
