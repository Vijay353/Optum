/**
 * V3 CH-1: domain reads go through typed ports, not around them.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { api, countRows, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";
import { MockEhrAdapter } from "../src/adapters/MockEhrAdapter";
import { MockSimulatorProbeAdapter } from "../src/adapters/MockSimulatorProbeAdapter";
import { FhirEhrAdapter, ProviderNotConfiguredError } from "../src/adapters/production";
import { FhirTaskSchema } from "../src/domain/contracts";
import { setFault } from "../src/simulators/shared";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

const opts = (e: TestEnv, path: string, token: string) => ({ baseUrl: `${e.baseUrl}${path}`, token, timeoutMs: 1000, maxRetries: 0, baseBackoffMs: 10 });
async function checkAndStage(e: TestEnv) {
  const c = (await api<{ run: Run }>(e, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
  return (await api<{ run: Run }>(e, "POST", `/api/runs/${c.runId}/stage`)).body.run;
}

describe("EhrPort.listTasksForDraft (adapter contract)", () => {
  it("returns schema-valid tasks for the draft, and none for other drafts", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const ehr = new MockEhrAdapter(opts(env, "/mock-ehr", "eb-orchestrator-local"), "eb-ehr-workflow-local");
    expect(await ehr.listTasksForDraft("PA-DRAFT-99412")).toEqual([]);
    await checkAndStage(env);
    const tasks = await ehr.listTasksForDraft("PA-DRAFT-99412");
    expect(tasks).toHaveLength(1);
    expect(FhirTaskSchema.safeParse(tasks[0]).success).toBe(true);
    expect(tasks[0]?.id).toBe("TASK-EVID-1042");
    expect(await ehr.listTasksForDraft("PA-DRAFT-99413")).toEqual([]);
  });

  it("a token without Task.read is refused", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const ehr = new MockEhrAdapter(opts(env, "/mock-ehr", "eb-ehr-workflow-local"), "eb-ehr-workflow-local");
    await expect(ehr.listTasksForDraft("PA-DRAFT-99412")).rejects.toMatchObject({ status: 403 });
  });
});

describe("SimulatorProbePort (SIMULATED only)", () => {
  it("counts non-GET requests the payer received since a time", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const probe = new MockSimulatorProbeAdapter(opts(env, "/mock-payer", "eb-orchestrator-local"));
    const since = "2026-10-18T00:00:00Z";
    expect(await probe.countPayerWriteRequestsSince(since)).toBe(0);
    const r = await fetch(`${env.baseUrl}/mock-payer/fhir/Claim/$submit`, { method: "POST", headers: { authorization: "Bearer eb-orchestrator-local" } });
    expect(r.status).toBe(405);
    expect(await probe.countPayerWriteRequestsSince(since)).toBe(1);
    expect(await probe.countPayerWriteRequestsSince("2099-01-01T00:00:00Z")).toBe(0);
  });

  it("only clients with SimProbe.read may call it", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    for (const token of ["eb-ehr-workflow-local", "eb-demo-clinician-local", "eb-sim-admin-local"]) {
      const probe = new MockSimulatorProbeAdapter(opts(env, "/mock-payer", token));
      await expect(probe.countPayerWriteRequestsSince("2026-10-18T00:00:00Z"), token).rejects.toMatchObject({ status: 403 });
    }
  });

  it("a probe failure during read-back never ends as success, and a retry recovers", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const c = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    setFault(env.db, "payer.probe", { kind: "status", status: 503, remaining: 3 });
    const s = (await api<{ run: Run }>(env, "POST", `/api/runs/${c.runId}/stage`)).body.run;
    expect(s.status).toBe("FAILED_RETRYABLE");
    expect(s.execution.readback?.verified).toBe(false);
    expect(countRows(env.db, "ehr_tasks")).toBe(1); // the task may exist; the run does not claim success
    const retry = (await api<{ run: Run }>(env, "POST", `/api/runs/${c.runId}/stage`)).body.run;
    expect(retry.status).toBe("COMPLETED");
    expect(retry.execution.result?.duplicate).toBe(true);
    expect(retry.execution.payerWriteRequests).toBe(0);
    expect(countRows(env.db, "ehr_tasks")).toBe(1);
  });

  it("the read-back step shows the probe as a real HTTP call", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const s = await checkAndStage(env);
    const step = s.trace.find((t) => t.step === "READ_AFTER_WRITE");
    expect(step?.calls.map((c) => c.path.split("?")[0])).toEqual(["/mock-ehr/fhir/Task/TASK-EVID-1042", "/mock-ehr/prior-auth-drafts/PA-DRAFT-99412", "/mock-payer/_admin/write-count"]);
    expect(s.execution.readback?.checks.find((c) => c.name === "payer write requests during run")).toMatchObject({ pass: true, actual: "0" });
  });
});

describe("non-simulated adapters stay NOT_CONFIGURED", () => {
  it("FhirEhrAdapter.listTasksForDraft fails closed", () => {
    const a = new FhirEhrAdapter({ baseUrl: "https://ehr.example.invalid", clientId: "x", clientSecret: "y" });
    expect(() => a.listTasksForDraft("PA-DRAFT-99412")).toThrow(ProviderNotConfiguredError);
  });
});

describe("workspace API keeps its shape", () => {
  it("returns the same draft and task fields through the port", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    await checkAndStage(env);
    const ws = (await api<{ draft: Record<string, unknown>; tasks: Record<string, unknown>[] }>(env, "GET", "/api/workspace")).body;
    expect(Object.keys(ws.draft).sort()).toEqual(["businessStatus", "coverageId", "createdAt", "id", "meta", "patientId", "policyVersion", "resourceType", "serviceRequestId", "updatedAt", "version"]);
    expect(Object.keys(ws.tasks[0] ?? {}).sort()).toEqual(["authoredOn", "businessStatus", "code", "focus", "for", "id", "input", "intent", "meta", "owner", "resourceType", "restriction", "status"]);
    const missing = (await api<{ draft: unknown; tasks: unknown[] }>(env, "GET", "/api/workspace?draftId=PA-DRAFT-00000")).body;
    expect(missing.draft).toBeNull();
    expect(missing.tasks).toEqual([]);
  });
});

describe("architecture: no simulator-table SQL outside its owners", () => {
  it("only src/simulators, src/persistence and src/data touch ehr_/payer_/hie_/policy_ tables", () => {
    const allowed = [join("src", "simulators"), join("src", "persistence"), join("src", "data")];
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f) && !allowed.some((a) => p.startsWith(a))) {
          const text = readFileSync(p, "utf8");
          if (/\b(FROM|INTO|UPDATE|JOIN)\s+(ehr_|payer_|hie_|policy_versions)/i.test(text)) offenders.push(p);
        }
      }
    };
    walk("src");
    walk("server");
    expect(offenders).toEqual([]);
  });
});
