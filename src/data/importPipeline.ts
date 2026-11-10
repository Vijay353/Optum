/**
 * Import pipeline: parse → validate → diff/preview → (confirm) → atomic commit
 * → re-query verification. Plus import history and safe restore.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../persistence/db";
import { nowIso } from "../persistence/db";
import { canonicalJson, sha256Hex } from "../domain/integrity";
import { ENTITY_KEYS, primaryKey, validateDataset, type Dataset, type EntityKey, type ValidationIssue } from "./dataset";
import { readDataset, restoreSnapshot, snapshotDataset, writeDataset } from "./datasetStore";
import { parseCsv, parseWorkbook, type RawRows } from "./workbook";

export type ImportMode = "merge" | "replace";
export type EntityDiff = { added: number; updated: number; unchanged: number; rejected: number; removed: number };
export type ImportPreview = {
  batchId: string | null;
  filename: string;
  mode: ImportMode;
  schemaVersion: string | null;
  canCommit: boolean;
  issues: ValidationIssue[];
  diff: Record<string, EntityDiff>;
};

const datasetHash = (ds: Dataset) => sha256Hex(canonicalJson(ds));

function asRaw(ds: Dataset): RawRows {
  return Object.fromEntries(
    ENTITY_KEYS.map((k) => [k, (ds[k] as unknown as Record<string, unknown>[]).map((data, i) => ({ rowNumber: -(i + 1), data }))]),
  ) as unknown as RawRows;
}

export async function previewImport(db: Db, input: { buffer: Buffer; filename: string; mode: ImportMode }): Promise<ImportPreview> {
  const isCsv = /\.csv$/i.test(input.filename);
  const isXlsx = /\.xlsx$/i.test(input.filename);
  const base: ImportPreview = { batchId: null, filename: input.filename, mode: input.mode, schemaVersion: null, canCommit: false, issues: [], diff: {} };
  if (!isCsv && !isXlsx) return { ...base, issues: [{ sheet: "file", row: null, column: null, message: "only .xlsx and .csv files are accepted (.xlsm and other formats are refused)" }] };

  const parsed = isCsv
    ? { ...parseCsv(input.buffer.toString("utf8"), input.filename), schemaVersion: "csv" }
    : await parseWorkbook(input.buffer);
  const issues = [...parsed.issues];
  const fileLevel = issues.some((i) => i.sheet === "file" || i.sheet === "_meta" || i.row === 1 || i.row === null);
  if (input.mode === "replace") {
    if (isCsv) issues.push({ sheet: "file", row: null, column: null, message: "replace mode requires a full .xlsx workbook" });
    for (const k of ENTITY_KEYS) if (!parsed.presentSheets.includes(k)) issues.push({ sheet: k, row: null, column: null, message: "required sheet is missing (replace mode needs every sheet)" });
  } else if (parsed.presentSheets.length === 0 && !issues.length) {
    issues.push({ sheet: "file", row: null, column: null, message: "no recognised entity sheets found" });
  }

  const current = readDataset(db);
  const incoming = parsed.raw;

  // Duplicate primary keys inside the file (must be caught before merge overlay collapses them).
  for (const k of ENTITY_KEYS) {
    const seenPk = new Map<string, number>();
    for (const r of incoming[k]) {
      const pk = primaryKey(k, r.data);
      if (seenPk.has(pk)) {
        issues.push({ sheet: k, row: r.rowNumber, column: null, message: `duplicate primary key ${pk} (first seen on row ${seenPk.get(pk)})` });
        r.data.__invalid = true;
        r.data.__duplicate = true;
      } else seenPk.set(pk, r.rowNumber);
    }
  }
  if (input.mode === "merge") {
    for (const k of ENTITY_KEYS) incoming[k] = incoming[k].filter((r) => !r.data.__duplicate);
  }

  // Domain checks against current state (stale revisions, system-managed rows).
  const curDrafts = new Map(current.prior_auth_drafts.map((d) => [d.id, d]));
  for (const r of incoming.prior_auth_drafts) {
    const cur = curDrafts.get(String(r.data.id));
    if (!cur || r.data.__invalid) continue;
    const ver = Number(r.data.version);
    if (input.mode === "merge" && cur.businessStatus === "EVIDENCE_REVIEW_PENDING") {
      issues.push({ sheet: "prior_auth_drafts", row: r.rowNumber, column: "businessStatus", message: `draft ${cur.id} is in EVIDENCE_REVIEW_PENDING (system-managed) and cannot be changed by import` });
      r.data.__invalid = true;
    } else if (input.mode === "merge" && ver < cur.version) {
      issues.push({ sheet: "prior_auth_drafts", row: r.rowNumber, column: "version", message: `stale revision: incoming v${ver} is older than current v${cur.version}` });
      r.data.__invalid = true;
    } else if (input.mode === "merge" && ver === cur.version && canonicalJson({ ...r.data, updatedAt: null, businessStatus: null }) !== canonicalJson({ ...cur, updatedAt: null, businessStatus: null })) {
      issues.push({ sheet: "prior_auth_drafts", row: r.rowNumber, column: "version", message: `draft ${cur.id} changed without a version increase (current v${cur.version})` });
      r.data.__invalid = true;
    }
  }

  // Build the candidate dataset.
  let candidate: Dataset;
  const rejectedIncoming: Record<EntityKey, Set<string>> = Object.fromEntries(ENTITY_KEYS.map((k) => [k, new Set<string>()])) as Record<EntityKey, Set<string>>;
  if (input.mode === "replace") {
    const v = validateDataset(incoming);
    issues.push(...v.issues);
    candidate = v.dataset;
    for (const k of ENTITY_KEYS) for (const pk of v.rejectedKeys[k]) rejectedIncoming[k].add(pk);
  } else {
    // Merge: overlay incoming rows on current rows, then validate the combination.
    const combined = asRaw(current);
    for (const k of ENTITY_KEYS) {
      for (const r of incoming[k]) {
        const pk = primaryKey(k, r.data);
        if (k === "document_contents") {
          // Content for a document is replaced as a whole when any of its pages is imported.
          const docId = String(r.data.documentId);
          combined[k] = combined[k].filter((x) => x.rowNumber > 0 || String(x.data.documentId) !== docId);
        }
        const idx = combined[k].findIndex((x) => primaryKey(k, x.data) === pk);
        if (idx >= 0) combined[k][idx] = r;
        else combined[k].push(r);
      }
    }
    let v = validateDataset(combined);
    // Any rejected key that came from the file is rejected; current rows are restored for those keys.
    for (const k of ENTITY_KEYS) {
      for (const pk of v.rejectedKeys[k]) {
        if (incoming[k].some((r) => primaryKey(k, r.data) === pk)) rejectedIncoming[k].add(pk);
      }
    }
    if (ENTITY_KEYS.some((k) => rejectedIncoming[k].size)) {
      const restored = asRaw(current);
      for (const k of ENTITY_KEYS) {
        for (const r of incoming[k]) {
          const pk = primaryKey(k, r.data);
          if (rejectedIncoming[k].has(pk)) continue;
          const idx = restored[k].findIndex((x) => primaryKey(k, x.data) === pk);
          if (idx >= 0) restored[k][idx] = r;
          else restored[k].push(r);
        }
      }
      const second = validateDataset(restored);
      issues.push(...v.issues.filter((i) => i.row !== null && i.row > 0));
      for (const k of ENTITY_KEYS) for (const pk of second.rejectedKeys[k]) rejectedIncoming[k].add(pk);
      issues.push(...second.issues.filter((i) => i.row !== null && i.row > 0 && !v.issues.some((x) => x.row === i.row && x.sheet === i.sheet && x.message === i.message)));
      v = second;
    } else {
      issues.push(...v.issues.filter((i) => i.row !== null && i.row > 0));
    }
    candidate = v.dataset;
  }

  // Diff.
  const diff: Record<string, EntityDiff> = {};
  for (const k of ENTITY_KEYS) {
    const curMap = new Map((current[k] as unknown as Record<string, unknown>[]).map((r) => [primaryKey(k, r), canonicalJson(r)]));
    const d: EntityDiff = { added: 0, updated: 0, unchanged: 0, rejected: 0, removed: 0 };
    const seen = new Set<string>();
    for (const r of incoming[k]) {
      const pk = primaryKey(k, r.data);
      if (seen.has(pk)) { d.rejected++; continue; }
      seen.add(pk);
      if (rejectedIncoming[k].has(pk) || r.data.__invalid) { d.rejected++; continue; }
      const accepted = (candidate[k] as unknown as Record<string, unknown>[]).find((x) => primaryKey(k, x) === pk);
      if (!accepted) { d.rejected++; continue; }
      const prev = curMap.get(pk);
      const sameAsCurrent = prev !== undefined && (prev === canonicalJson(accepted) || (k === "prior_auth_drafts" && sameDraftIgnoringStatus(prev, accepted)));
      if (prev === undefined) d.added++;
      else if (sameAsCurrent) d.unchanged++;
      else d.updated++;
    }
    if (input.mode === "replace") for (const pk of curMap.keys()) if (!seen.has(pk)) d.removed++;
    if (incoming[k].length || d.removed) diff[k] = d;
  }

  const rejectedTotal = Object.values(diff).reduce((n, d) => n + d.rejected, 0);
  const changes = Object.values(diff).reduce((n, d) => n + d.added + d.updated + d.removed, 0);
  const blocking = fileLevel || issues.some((i) => i.sheet === "file" || i.sheet === "_meta" || i.row === null || i.row === 1);
  const canCommit = !blocking && changes > 0 && (input.mode === "merge" || rejectedTotal === 0);

  const batchId = canCommit ? `IMP-${randomUUID().slice(0, 8).toUpperCase()}` : null;
  db.prepare("INSERT INTO app_import_batches (id, at, filename, mode, sha256, status, summary_json, staged_json) VALUES (?,?,?,?,?,?,?,?)").run(
    batchId ?? `IMP-REJ-${randomUUID().slice(0, 8).toUpperCase()}`,
    nowIso(db), input.filename, input.mode, sha256Hex(input.buffer), canCommit ? "PREVIEWED" : changes === 0 && !issues.length ? "NO_CHANGES" : "REJECTED",
    JSON.stringify({ diff, issueCount: issues.length, baseHash: datasetHash(current) }),
    canCommit ? JSON.stringify(candidate) : null,
  );
  return { ...base, batchId, schemaVersion: parsed.schemaVersion, canCommit, issues, diff };
}

function sameDraftIgnoringStatus(prevJson: string, accepted: Record<string, unknown>): boolean {
  const prev = JSON.parse(prevJson) as Record<string, unknown>;
  return canonicalJson({ ...prev, businessStatus: null }) === canonicalJson({ ...accepted, businessStatus: null });
}

export function commitImport(db: Db, batchId: string): { batchId: string; committed: boolean; verified: boolean; counts: Record<string, number> } {
  const b = db.prepare("SELECT * FROM app_import_batches WHERE id = ?").get(batchId) as
    | { id: string; mode: ImportMode; status: string; summary_json: string; staged_json: string | null }
    | undefined;
  if (!b) throw new ImportError(404, "import batch not found");
  if (b.status !== "PREVIEWED" || !b.staged_json) throw new ImportError(409, `batch is ${b.status}; only a previewed batch can be committed once`);
  const summary = JSON.parse(b.summary_json) as { baseHash: string };
  const current = readDataset(db);
  if (datasetHash(current) !== summary.baseHash) {
    db.prepare("UPDATE app_import_batches SET status = 'STALE' WHERE id = ?").run(batchId);
    throw new ImportError(409, "simulator data changed since this preview; preview the file again");
  }
  const staged = JSON.parse(b.staged_json) as Dataset;
  // Preserve system-managed draft status on merge.
  if (b.mode === "merge") {
    const cur = new Map(current.prior_auth_drafts.map((d) => [d.id, d.businessStatus]));
    for (const d of staged.prior_auth_drafts) d.businessStatus = (cur.get(d.id) ?? "DRAFT_INCOMPLETE") as never;
  }
  const snapshot = snapshotDataset(db);
  writeDataset(db, staged, b.mode);

  // Independent re-query: every staged row must now be present and equal.
  const after = readDataset(db);
  let verified = true;
  const counts: Record<string, number> = {};
  for (const k of ENTITY_KEYS) {
    const map = new Map((after[k] as unknown as Record<string, unknown>[]).map((r) => [primaryKey(k, r), canonicalJson(r)]));
    counts[k] = map.size;
    for (const r of staged[k] as unknown as Record<string, unknown>[]) {
      if (map.get(primaryKey(k, r)) !== canonicalJson(r)) verified = false;
    }
  }
  db.prepare("UPDATE app_import_batches SET status = ?, pre_snapshot_json = ?, staged_json = NULL WHERE id = ?").run(verified ? "COMMITTED" : "COMMITTED_UNVERIFIED", snapshot, batchId);
  return { batchId, committed: true, verified, counts };
}

export function restoreBeforeImport(db: Db, batchId: string): void {
  const b = db.prepare("SELECT status, pre_snapshot_json FROM app_import_batches WHERE id = ?").get(batchId) as { status: string; pre_snapshot_json: string | null } | undefined;
  if (!b?.pre_snapshot_json) throw new ImportError(404, "no snapshot for this batch");
  restoreSnapshot(db, b.pre_snapshot_json);
  db.prepare("UPDATE app_import_batches SET status = 'RESTORED' WHERE id = ?").run(batchId);
}

export function listBatches(db: Db) {
  return (db.prepare("SELECT id, at, filename, mode, status, summary_json FROM app_import_batches ORDER BY at DESC LIMIT 50").all() as Record<string, string>[]).map((r) => ({
    id: r.id, at: r.at, filename: r.filename, mode: r.mode, status: r.status, summary: JSON.parse(String(r.summary_json)),
  }));
}

export class ImportError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}
