/**
 * Consistent SQLite backup and restore check (V3 CH-22).
 * Uses the SQLite online backup API (node:sqlite backup), safe while the app writes in WAL mode.
 * Never copy the live .sqlite file by hand while the app is running.
 */
import { backup, DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db";
import { verifyChain, type ChainReport } from "./auditChain";

const TABLES = ["ehr_prior_auth_drafts", "ehr_tasks", "ehr_audit", "app_runs", "app_audit", "app_import_batches"] as const;
export const BACKUP_PATTERN = /^evidencebridge-\d{8}T\d{6}Z\.sqlite$/;

export type Snapshot = { counts: Record<string, number>; chains: Pick<ChainReport, "table" | "status" | "lastSeq">[]; integrity: string };

export function snapshot(db: Db): Snapshot {
  const counts = Object.fromEntries(TABLES.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
  const chains = (["ehr_audit", "app_audit"] as const).map((t) => verifyChain(db, t)).map(({ table, status, lastSeq }) => ({ table, status, lastSeq }));
  const integrity = String((db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>).integrity_check);
  return { counts, chains, integrity };
}

export function backupName(at: Date): string {
  return `evidencebridge-${at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}.sqlite`;
}

export type BackupResult = { file: string; source: Snapshot; restored: Snapshot; matches: boolean; pruned: string[] };

/** Writes a consistent copy, then opens the copy separately and compares it with the source. */
export async function backupAndVerify(db: Db, destDir: string, opts: { keep?: number; now?: Date } = {}): Promise<BackupResult> {
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const file = join(destDir, backupName(opts.now ?? new Date()));
  const source = snapshot(db);
  await backup(db, file);
  // Make the copy a single self-contained file (no -wal/-shm sidecars), then check it read-only.
  const rw = new DatabaseSync(file);
  rw.exec("PRAGMA journal_mode = DELETE;");
  rw.close();
  chmodSync(file, 0o600);
  const copy = new DatabaseSync(file, { readOnly: true });
  let restored: Snapshot;
  try {
    restored = snapshot(copy as unknown as Db);
  } finally {
    copy.close();
  }
  const matches = JSON.stringify(source) === JSON.stringify(restored) && restored.integrity === "ok";
  const pruned: string[] = [];
  const keep = opts.keep ?? 14;
  const files = readdirSync(destDir).filter((f) => BACKUP_PATTERN.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    for (const side of ["", "-wal", "-shm", "-journal"]) rmSync(join(destDir, f + side), { force: true });
    pruned.push(f);
  }
  return { file, source, restored, matches, pruned };
}
