/** V3 CH-17: tamper-evident audit hash chain, with honest limits. */
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, countRows, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";
import { openDb } from "../src/persistence/db";
import { appendAppAudit, appendEhrAudit } from "../src/persistence/auditStore";
import { canonicalBytes, entryHash, GENESIS, verifyChain } from "../src/persistence/auditChain";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

async function stagedEnv() {
  env = await startTestServer({ scenario: "primary-success" });
  const c = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
  await api(env, "POST", `/api/runs/${c.runId}/stage`);
  return env;
}
const seqs = (db: DatabaseSync, t: string) => (db.prepare(`SELECT seq FROM ${t} ORDER BY seq`).all() as { seq: number }[]).map((r) => r.seq);

describe("chain over real workflow rows", () => {
  it("verifies after a full run, through the API", async () => {
    const e = await stagedEnv();
    const r = (await api<{ tables: Array<{ table: string; status: string; legacyRows: number; hashedRows: number }> }>(e, "GET", "/api/audit/verify")).body;
    for (const t of r.tables) expect(t, t.table).toMatchObject({ status: "OK", legacyRows: 0 });
    expect(r.tables.find((t) => t.table === "ehr_audit")!.hashedRows).toBe(countRows(e.db, "ehr_audit"));
    const first = e.db.prepare("SELECT prev_hash FROM app_audit ORDER BY seq LIMIT 1").get() as { prev_hash: string };
    expect(first.prev_hash).toBe(GENESIS);
  });

  it("a changed detail in the middle is caught at that row", async () => {
    const e = await stagedEnv();
    const mid = seqs(e.db, "app_audit")[2]!;
    e.db.prepare("UPDATE app_audit SET detail_json = '{\"decision\":\"APPROVED\"}' WHERE seq = ?").run(mid);
    expect(verifyChain(e.db, "app_audit")).toMatchObject({ status: "TAMPERED", firstBadSeq: mid });
  });

  it("a deleted middle row is caught at the next row; a deleted last row is caught by the head anchor", async () => {
    const e = await stagedEnv();
    const s = seqs(e.db, "ehr_audit");
    e.db.prepare("DELETE FROM ehr_audit WHERE seq = ?").run(s[1]!);
    expect(verifyChain(e.db, "ehr_audit")).toMatchObject({ status: "TAMPERED", firstBadSeq: s[2] });
    const s2 = seqs(e.db, "app_audit");
    e.db.prepare("DELETE FROM app_audit WHERE seq = ?").run(s2[s2.length - 1]!);
    expect(verifyChain(e.db, "app_audit").reason).toMatch(/head anchor/);
  });

  it("a removed hash after the chain started is caught", async () => {
    const e = await stagedEnv();
    const s = seqs(e.db, "app_audit");
    e.db.prepare("UPDATE app_audit SET entry_hash = NULL WHERE seq = ?").run(s[1]!);
    expect(verifyChain(e.db, "app_audit")).toMatchObject({ status: "TAMPERED", firstBadSeq: s[1] });
  });

  it("an idempotent replay adds its own audit row but no duplicate TASK_CREATED, and the chain still verifies", async () => {
    const e = await stagedEnv();
    const c = (await api<{ run: Run }>(e, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    await api(e, "POST", `/api/runs/${c.runId}/stage`);
    expect(countRows(e.db, "ehr_audit", "action = 'TASK_CREATED'")).toBe(1);
    expect(countRows(e.db, "ehr_audit", "action = 'TASK_CREATE_REPLAYED'")).toBe(1);
    expect(verifyChain(e.db, "ehr_audit").status).toBe("OK");
  });

  it("a scenario reset clears rows and anchors together", async () => {
    const e = await stagedEnv();
    await api(e, "POST", "/api/scenarios/primary-success/load");
    expect(verifyChain(e.db, "ehr_audit").status).toBe("NO_ROWS");
    expect(verifyChain(e.db, "app_audit").status).toBe("NO_ROWS");
  });
});

describe("canonical encoding", () => {
  it("is deterministic and unambiguous", () => {
    const row = { seq: 7, at: "2026-10-18T13:10:00.000Z", run_id: null, type: "T", detail_json: "{}" };
    expect(canonicalBytes("app_audit", row, GENESIS)).toBe(canonicalBytes("app_audit", { ...row }, GENESIS));
    expect(entryHash("app_audit", row, GENESIS)).not.toBe(entryHash("app_audit", { ...row, run_id: "" }, GENESIS)); // null is not ""
    expect(entryHash("app_audit", { ...row, type: "a|b" }, GENESIS)).not.toBe(entryHash("app_audit", { ...row, type: "a", detail_json: "b|{}" }, GENESIS));
    expect(entryHash("app_audit", row, GENESIS)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("migration and restart", () => {
  it("an older database gains the columns; its old rows are unverifiable and new rows chain after them", () => {
    const path = join(mkdtempSync(join(tmpdir(), "eb-legacy-")), "legacy.sqlite");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE app_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, run_id TEXT, type TEXT NOT NULL, detail_json TEXT NOT NULL)");
    old.exec("INSERT INTO app_audit (at, run_id, type, detail_json) VALUES ('2026-10-01T00:00:00Z', NULL, 'OLD', '{}'), ('2026-10-02T00:00:00Z', NULL, 'OLD', '{}')");
    old.close();
    let db = openDb(path);
    expect(verifyChain(db, "app_audit")).toMatchObject({ status: "UNVERIFIABLE", legacyRows: 2 });
    appendAppAudit(db, null, "NEW", {});
    appendEhrAudit(db, "test", "NEW", "x", {});
    expect(verifyChain(db, "app_audit")).toMatchObject({ status: "OK", legacyRows: 2, hashedRows: 1, firstHashedSeq: 3 });
    expect(verifyChain(db, "app_audit").reason).toMatch(/not verifiable/);
    db.close();
    db = openDb(path); // restart: columns already there, chain still verifies
    expect(verifyChain(db, "app_audit").status).toBe("OK");
    expect(verifyChain(db, "ehr_audit").status).toBe("OK");
    db.close();
  });
});
