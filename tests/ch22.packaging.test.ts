/** V3 CH-22 (CH-22A dry run): runtime config, startup safety, restart persistence, backup and restore check, image rules. */
import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/server/config";
import { openDb } from "../src/persistence/db";
import { loadScenario } from "../src/server/scenarios";
import { assertWritableDataDir, startupSeedDecision } from "../src/server/bootstrap";
import { backupAndVerify, BACKUP_PATTERN } from "../src/persistence/backup";
import { verifyChain } from "../src/persistence/auditChain";
import { startTestServer } from "./helpers";

const tmp = mkdtempSync(join(tmpdir(), "eb-ch22-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("config", () => {
  it("binds loopback by default; container settings and aliases work", () => {
    const d = loadConfig({});
    expect(d.host).toBe("127.0.0.1");
    expect(d.port).toBe(8787);
    expect(d.dbPath).toBe("data/runtime/evidencebridge.sqlite");
    const c = loadConfig({ EB_HOST: "0.0.0.0", PORT: "3000", DATABASE_PATH: "/data/x.sqlite" });
    expect([c.host, c.port, c.dbPath]).toEqual(["0.0.0.0", 3000, "/data/x.sqlite"]);
    expect(loadConfig({ EB_PORT: "9001", PORT: "3000", EB_DB_PATH: "a.sqlite", DATABASE_PATH: "b.sqlite" })).toMatchObject({ port: 9001, dbPath: "a.sqlite" });
  });
});

describe("startup safety", () => {
  it("an unwritable data directory stops startup with a clear message", () => {
    const f = join(tmp, "not-a-dir");
    writeFileSync(f, "x");
    expect(() => assertWritableDataDir(join(f, "db.sqlite"))).toThrow(/is not writable .*Refusing to start/);
    expect(() => assertWritableDataDir(join(tmp, "ok", "db.sqlite"))).not.toThrow();
  });

  it("seeds only an empty database; never reseeds one with records", () => {
    const db = openDb(":memory:");
    expect(startupSeedDecision(db, {}).action).toBe("seed");
    expect(startupSeedDecision(db, { EB_BOOTSTRAP: "never" }).action).toBe("wait");
    expect(() => startupSeedDecision(db, { EB_BOOTSTRAP: "always" })).toThrow(/Unknown EB_BOOTSTRAP/);
    loadScenario(db, "primary-success");
    expect(startupSeedDecision(db, {})).toMatchObject({ action: "keep", reason: expect.stringMatching(/No reseed/) });
    db.prepare("DELETE FROM app_meta WHERE key = 'activeScenario'").run();
    expect(startupSeedDecision(db, {})).toMatchObject({ action: "keep", reason: expect.stringMatching(/has records/) });
    db.close();
  });

  it("/healthz answers without a role and without details", async () => {
    const env = await startTestServer({ scenario: "primary-success" });
    const r = await fetch(`${env.baseUrl}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    await env.close();
  });
});

function startServer(dbPath: string, port: number): Promise<ChildProcess> {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "server/index.ts"], {
      env: { ...process.env, EB_DB_PATH: dbPath, EB_PORT: String(port), EB_HOST: "127.0.0.1", NODE_ENV: "test", EB_MODE: "SIMULATED", EB_EXTRACTOR: "fixture" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 20000);
    child.stdout!.on("data", (d) => { out += String(d); if (out.includes("EvidenceBridge listening")) { clearTimeout(timer); resolveP(child); } });
    child.stderr!.on("data", (d) => { out += String(d); });
    child.on("exit", (code) => { clearTimeout(timer); if (!out.includes("listening")) reject(new Error(`exited ${code}: ${out}`)); });
  });
}
const stop = (c: ChildProcess) => new Promise<void>((r) => { c.on("exit", () => r()); c.kill("SIGTERM"); });

describe("restart persistence (real process, file database)", () => {
  it("state, audit chain and the written task survive a restart with no reseed and no duplicate write", async () => {
    const dbPath = join(tmp, "persist", "evidencebridge.sqlite");
    const port = 18700 + Math.floor(Math.random() * 200);
    const base = `http://127.0.0.1:${port}`;
    const call = async (method: string, path: string) => (await fetch(base + path, { method, headers: { "x-demo-role": "pa-specialist", "content-type": "application/json" } })).json() as Promise<Record<string, unknown>>;

    let srv = await startServer(dbPath, port);
    const run = (await call("POST", "/api/drafts/PA-DRAFT-99412/check")).run as { runId: string };
    await call("POST", `/api/runs/${run.runId}/stage`);
    await stop(srv);
    const before = new DatabaseSync(dbPath, { readOnly: true });
    const count = (d: DatabaseSync, t: string) => (d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const snap = { tasks: count(before, "ehr_tasks"), ehr: count(before, "ehr_audit"), app: count(before, "app_audit") };
    before.close();
    expect(snap.tasks).toBe(1);

    srv = await startServer(dbPath, port);
    const ws = (await call("GET", "/api/workspace")) as { tasks: unknown[]; draft: { businessStatus: string } };
    expect(ws.tasks).toHaveLength(1);
    expect(ws.draft.businessStatus).toBe("EVIDENCE_REVIEW_PENDING"); // not reset to the seeded DRAFT_INCOMPLETE
    // Same run staged again after restart: idempotent, no second task.
    await call("POST", `/api/runs/${run.runId}/stage`);
    const verify = (await call("GET", "/api/audit/verify")) as { tables: { status: string }[] };
    expect(verify.tables.map((t) => t.status)).toEqual(["OK", "OK"]);
    await stop(srv);
    const after = openDb(dbPath);
    expect(count(after as unknown as DatabaseSync, "ehr_tasks")).toBe(1);
    expect(count(after as unknown as DatabaseSync, "ehr_audit")).toBeGreaterThanOrEqual(snap.ehr);
    expect(verifyChain(after, "ehr_audit").status).toBe("OK");
    after.close();
  }, 60000);
});

describe("backup and restore check", () => {
  it("makes a consistent copy that matches the source, with private permissions and retention", async () => {
    const db = openDb(join(tmp, "b", "live.sqlite"));
    loadScenario(db, "primary-success");
    const dest = join(tmp, "b", "backups");
    const times = ["2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", "2026-11-03T00:00:00Z"];
    let last;
    for (const t of times) last = await backupAndVerify(db, dest, { keep: 2, now: new Date(t) });
    expect(last!.matches).toBe(true);
    expect(last!.restored.integrity).toBe("ok");
    expect(last!.restored.chains).toEqual(last!.source.chains);
    for (const c of last!.restored.chains) expect(["OK", "NO_ROWS"]).toContain(c.status);
    expect(statSync(last!.file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dest).filter((f) => !BACKUP_PATTERN.test(f))).toEqual([]); // no -wal/-shm sidecars left behind
    const kept = readdirSync(dest).filter((f) => BACKUP_PATTERN.test(f));
    expect(kept).toEqual(["evidencebridge-20261102T000000Z.sqlite", "evidencebridge-20261103T000000Z.sqlite"]);
    // Restore into an isolated throwaway database and use it.
    const restored = openDb(last!.file);
    expect(verifyChain(restored, "ehr_audit").status).toBe(last!.source.chains[0]!.status);
    expect((restored.prepare("SELECT COUNT(*) AS n FROM ehr_prior_auth_drafts").get() as { n: number }).n).toBe(last!.source.counts.ehr_prior_auth_drafts);
    restored.close();
    db.close();
  });
});

describe("image rules (static checks on the committed files)", () => {
  const df = readFileSync("Dockerfile", "utf8");
  const ignore = readFileSync(".dockerignore", "utf8").split("\n");
  it("pins the base image, runs as non-root, binds 0.0.0.0 and keeps the database on /data", () => {
    expect(df).toMatch(/ARG NODE_IMAGE=node:22\.22\.0-bookworm-slim/);
    expect(df).not.toMatch(/:latest/);
    expect(df).toMatch(/^USER node$/m);
    expect(df).toMatch(/EB_HOST=0\.0\.0\.0/);
    expect(df).toMatch(/EB_DB_PATH=\/data\/evidencebridge\.sqlite/);
    expect(df).toMatch(/npm ci/);
    expect(df).not.toMatch(/COPY[^\n]*\.env/);
    expect(df).not.toMatch(/EB_ACCESS_PIN|EB_SESSION_SECRET/);
  });
  it("keeps secrets, databases and dependencies out of the build context", () => {
    for (const p of [".env", ".git", "node_modules", "data/runtime", "**/*.sqlite"]) expect(ignore).toContain(p);
  });
});
