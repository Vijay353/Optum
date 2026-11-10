/**
 * Tamper-evident hash chain for the audit tables (V3 CH-17).
 *
 * Each new row stores prev_hash (the previous chained row's entry_hash, or
 * GENESIS) and entry_hash = SHA-256 over a length-framed canonical encoding of
 * the row's immutable fields. The newest hash is also kept as a head anchor in
 * app_meta so a deleted last row is detectable.
 *
 * Honest limits: this is tamper-evident against simple edits only. Anyone with
 * write access to the database file can recompute the whole chain and the
 * anchor. It is not signed, not anchored outside this database, not immutable
 * and not a certification. Rows written before CH-17 have no hash and are
 * reported as unverifiable (neither valid nor tampered).
 */
import { createHash } from "node:crypto";
import type { Db } from "./db";

export const CHAIN_ALGORITHM = "EB-AUDIT-CHAIN-1";
export const GENESIS = "0".repeat(64);

export type AuditTable = "ehr_audit" | "app_audit";

/** Ordered immutable fields per table. The order is part of the format. */
const FIELDS: Record<AuditTable, readonly string[]> = {
  ehr_audit: ["seq", "at", "actor", "action", "resource", "detail_json"],
  app_audit: ["seq", "at", "run_id", "type", "detail_json"],
};

/** Length-framed: "<bytes>:<value>" per field; null is "-1:". Unambiguous for any content. */
export function canonicalBytes(table: AuditTable, row: Record<string, unknown>, prevHash: string): string {
  const frame = (v: unknown) => (v === null || v === undefined ? "-1:" : `${Buffer.byteLength(String(v), "utf8")}:${String(v)}`);
  return [frame(CHAIN_ALGORITHM), frame(table), ...FIELDS[table].map((f) => frame(row[f])), frame(prevHash)].join("|");
}

export function entryHash(table: AuditTable, row: Record<string, unknown>, prevHash: string): string {
  return createHash("sha256").update(canonicalBytes(table, row, prevHash), "utf8").digest("hex");
}

const headKey = (t: AuditTable) => `audit.head.${t}`;

/** Adds the chain columns to databases created before CH-17 (additive, safe to repeat). */
export function migrateAuditChain(db: Db): void {
  for (const t of ["ehr_audit", "app_audit"] as const) {
    const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("prev_hash")) db.exec(`ALTER TABLE ${t} ADD COLUMN prev_hash TEXT`);
    if (!cols.includes("entry_hash")) db.exec(`ALTER TABLE ${t} ADD COLUMN entry_hash TEXT`);
  }
}

/**
 * Inserts one audit row and its hash in one savepoint (works inside or outside
 * an outer transaction). Synchronous: no other write can interleave in-process.
 */
export function appendChained(db: Db, table: AuditTable, values: Record<string, string | null>): number {
  const cols = FIELDS[table].filter((f) => f !== "seq");
  db.exec("SAVEPOINT audit_append");
  try {
    const last = db.prepare(`SELECT entry_hash FROM ${table} WHERE entry_hash IS NOT NULL ORDER BY seq DESC LIMIT 1`).get() as { entry_hash: string } | undefined;
    const prev = last?.entry_hash ?? GENESIS;
    const r = db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => values[c] ?? null));
    const seq = Number(r.lastInsertRowid);
    const hash = entryHash(table, { ...values, seq }, prev);
    db.prepare(`UPDATE ${table} SET prev_hash = ?, entry_hash = ? WHERE seq = ?`).run(prev, hash, seq);
    db.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(headKey(table), `${seq}:${hash}`);
    db.exec("RELEASE audit_append");
    return seq;
  } catch (err) {
    db.exec("ROLLBACK TO audit_append");
    db.exec("RELEASE audit_append");
    throw err;
  }
}

/** Removes head anchors when the audit tables are cleared by a scenario reset. */
export function clearAuditAnchors(db: Db): void {
  db.prepare("DELETE FROM app_meta WHERE key LIKE 'audit.head.%'").run();
}

export type ChainReport = {
  table: AuditTable;
  algorithm: string;
  status: "OK" | "TAMPERED" | "NO_ROWS" | "UNVERIFIABLE";
  totalRows: number;
  legacyRows: number;
  hashedRows: number;
  firstHashedSeq: number | null;
  lastSeq: number | null;
  firstBadSeq: number | null;
  reason: string;
};

export function verifyChain(db: Db, table: AuditTable): ChainReport {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY seq`).all() as Array<Record<string, unknown>>;
  const base = { table, algorithm: CHAIN_ALGORITHM, totalRows: rows.length, legacyRows: 0, hashedRows: 0, firstHashedSeq: null as number | null, lastSeq: null as number | null, firstBadSeq: null as number | null };
  const bad = (seq: number | null, reason: string): ChainReport => ({ ...base, status: "TAMPERED", firstBadSeq: seq, reason });
  const head = (db.prepare("SELECT value FROM app_meta WHERE key = ?").get(headKey(table)) as { value: string } | undefined)?.value ?? null;
  if (rows.length === 0) {
    return head ? bad(null, "The head anchor names a row, but the table is empty: rows were deleted.") : { ...base, status: "NO_ROWS", reason: "No audit rows yet." };
  }
  let prev = GENESIS;
  let started = false;
  for (const row of rows) {
    const seq = Number(row.seq);
    base.lastSeq = seq;
    if (row.entry_hash === null || row.entry_hash === undefined) {
      if (started) return bad(seq, `Row ${seq} has no hash after the chain started: its hash was removed.`);
      base.legacyRows++;
      continue;
    }
    if (!started) { started = true; base.firstHashedSeq = seq; }
    base.hashedRows++;
    if (row.prev_hash !== prev) return bad(seq, `Row ${seq} does not link to the row before it: a row was deleted or changed.`);
    if (entryHash(table, row, prev) !== row.entry_hash) return bad(seq, `Row ${seq} does not match its hash: its content was changed.`);
    prev = String(row.entry_hash);
  }
  if (!started) return { ...base, status: "UNVERIFIABLE", reason: `All ${base.legacyRows} rows were written before hashing existed and cannot be verified.` };
  if (head !== `${base.lastSeq}:${prev}`) return bad(base.lastSeq, "The newest row does not match the head anchor: the last row(s) were deleted or the anchor was changed.");
  const legacy = base.legacyRows ? ` Rows before ${base.firstHashedSeq} (${base.legacyRows}) were written before hashing and are not verifiable.` : "";
  return { ...base, status: "OK", reason: `Rows ${base.firstHashedSeq} to ${base.lastSeq} verify.${legacy}` };
}
