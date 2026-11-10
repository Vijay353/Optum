/** V3 CH-18: audit evidence package. Built from persisted records only, honest about gaps. */
import { afterEach, describe, expect, it } from "vitest";
import { api, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";
import { PACKAGE_SCHEMA_VERSION, packageFilename, verifyPackageDigest } from "../src/orchestrator/evidencePackage";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

type Pkg = Record<string, unknown> & { evidenceStatus: string; missing: string[]; digest: { value: string }; audit: { app: { seq: number }[]; ehr: { kind: string; resource: string }[] }; write: { readback: { verified: boolean; taskId: string | null } | null } };

async function check(scenario: string, draft: string, stage = true) {
  env = await startTestServer({ scenario });
  const run = (await api<{ run: Run }>(env, "POST", `/api/drafts/${draft}/check`)).body.run;
  if (stage && run.status === "AWAITING_CONFIRMATION") await api(env, "POST", `/api/runs/${run.runId}/stage`);
  return run.runId;
}
async function exportPkg(runId: string, role = "pa-specialist") {
  const res = await fetch(`${env!.baseUrl}/api/runs/${runId}/evidence-package`, { headers: { "x-demo-role": role } });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe("CH-18 evidence package", () => {
  it("primary, written: complete, digest verifies, read-back and task are included", async () => {
    const runId = await check("primary-success", "PA-DRAFT-99412");
    const r = await exportPkg(runId);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toBe(`attachment; filename="${packageFilename(runId)}"`);
    const pkg = JSON.parse(r.text) as Pkg;
    expect(pkg.schemaVersion).toBe(PACKAGE_SCHEMA_VERSION);
    expect(pkg.evidenceStatus).toBe("complete");
    expect(pkg.missing).toEqual([]);
    expect(verifyPackageDigest(pkg).ok).toBe(true);
    expect(pkg.write.readback?.verified).toBe(true);
    expect(pkg.write.readback?.taskId).toMatch(/^Task-|^[A-Za-z0-9-]+$/);
    expect(pkg.audit.app.length).toBeGreaterThan(0);
    expect(pkg.audit.ehr.map((e) => e.kind)).toEqual(expect.arrayContaining(["TASK_CREATED", "DRAFT_STATUS_CHANGED"]));
    expect(JSON.stringify(pkg)).not.toMatch(/"signature"|signed by/i);
  });

  it("two exports of one run differ only in export time; one changed field breaks the digest", async () => {
    const runId = await check("primary-success", "PA-DRAFT-99412");
    const a = JSON.parse((await exportPkg(runId)).text) as Pkg;
    const b = JSON.parse((await exportPkg(runId)).text) as Pkg;
    const strip = ({ exportedAt: _e, digest: _d, ...rest }: Pkg) => rest;
    expect(strip(b)).toEqual(strip(a));
    expect(verifyPackageDigest(b).ok).toBe(true);
    const edited = { ...a, evidenceStatus: "complete", missing: ["x"] };
    expect(verifyPackageDigest(edited).ok).toBe(false);
  });

  it("never includes document text", async () => {
    const runId = await check("primary-success", "PA-DRAFT-99412");
    const text = (await exportPkg(runId)).text;
    const bodies = env!.db.prepare("SELECT content FROM hie_binaries").all() as { content: string }[];
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      const lines = String(b.content).split(/\\n|\n/).map((l) => l.trim()).filter((l) => l.length >= 30);
      for (const l of lines) expect(text.includes(l), l).toBe(false);
    }
    expect(text).toContain('"sourceTextIncluded":false');
  });

  it("awaiting confirmation: no write was asked for, so nothing is missing and no read-back is claimed", async () => {
    const runId = await check("primary-success", "PA-DRAFT-99412", false);
    const pkg = JSON.parse((await exportPkg(runId)).text) as Pkg;
    expect(pkg.evidenceStatus).toBe("complete"); // nothing missing: no write was asked for yet
    expect(pkg.write.readback).toBeNull();
  });

  it("read-back mismatch: partial, and the gap is named", async () => {
    const runId = await check("readback-mismatch", "PA-DRAFT-99412");
    const pkg = JSON.parse((await exportPkg(runId)).text) as Pkg;
    expect(pkg.evidenceStatus).toBe("partial");
    expect(pkg.missing.join(" ")).toMatch(/read-back is missing or did not match/);
    expect(pkg.write.readback?.verified).toBe(false);
  });

  it("blocked run (opt-out): exports with no write and no task", async () => {
    const runId = await check("opt-out", "PA-DRAFT-99414");
    const pkg = JSON.parse((await exportPkg(runId)).text) as Pkg & { decision: { ruleId: string } };
    expect(pkg.decision.ruleId).toBe("R1_ACCESS_GATE");
    expect(pkg.write.readback).toBeNull();
    expect(verifyPackageDigest(pkg).ok).toBe(true);
  });

  it("a tampered audit row makes the package unverifiable, not complete", async () => {
    const runId = await check("primary-success", "PA-DRAFT-99412");
    const seq = (env!.db.prepare("SELECT seq FROM app_audit WHERE run_id = ? ORDER BY seq LIMIT 1").get(runId) as { seq: number }).seq;
    env!.db.prepare("UPDATE app_audit SET detail_json = '{\"decision\":\"APPROVED\"}' WHERE seq = ?").run(seq);
    const pkg = JSON.parse((await exportPkg(runId)).text) as Pkg;
    expect(pkg.evidenceStatus).toBe("unverifiable");
    expect(pkg.missing.join(" ")).toMatch(/audit chain did not verify/);
  });

  it("viewer is refused; unknown run is 404; ids cannot inject into the filename", async () => {
    const runId = await check("primary-success", "PA-DRAFT-99412");
    expect((await exportPkg(runId, "viewer")).status).toBe(403);
    expect((await exportPkg(runId, "sim-admin")).status).toBe(200);
    expect((await exportPkg("RUN-nope")).status).toBe(404);
    expect(packageFilename('a"b/../c\r\nX')).toBe("evidence-package-abcX.json");
  });
});
