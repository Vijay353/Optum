/**
 * Append-only audit stores. There is no update/delete API. Every new row is
 * hash-chained (V3 CH-17, see auditChain.ts for limits).
 * Audit details hold identifiers and hashes — never document bodies.
 */
import type { Db } from "./db";
import { nowIso } from "./db";
import { appendChained } from "./auditChain";

export type AuditEntry = { seq: number; at: string; actor?: string; action?: string; type?: string; resource?: string; runId?: string | null; detail: Record<string, unknown> };

export function appendEhrAudit(db: Db, actor: string, action: string, resource: string, detail: Record<string, unknown>): void {
  appendChained(db, "ehr_audit", { at: nowIso(db), actor, action, resource, detail_json: JSON.stringify(detail) });
}

export function listEhrAudit(db: Db, limit = 200): AuditEntry[] {
  const rows = db.prepare("SELECT seq, at, actor, action, resource, detail_json FROM ehr_audit ORDER BY seq DESC LIMIT ?").all(limit) as {
    seq: number; at: string; actor: string; action: string; resource: string; detail_json: string;
  }[];
  return rows.map((r) => ({ seq: r.seq, at: r.at, actor: r.actor, action: r.action, resource: r.resource, detail: JSON.parse(r.detail_json) }));
}

export function appendAppAudit(db: Db, runId: string | null, type: string, detail: Record<string, unknown>): void {
  appendChained(db, "app_audit", { at: nowIso(db), run_id: runId, type, detail_json: JSON.stringify(detail) });
}

export function listAppAudit(db: Db, runId?: string): AuditEntry[] {
  const rows = (runId
    ? db.prepare("SELECT seq, at, run_id, type, detail_json FROM app_audit WHERE run_id = ? ORDER BY seq").all(runId)
    : db.prepare("SELECT seq, at, run_id, type, detail_json FROM app_audit ORDER BY seq DESC LIMIT 200").all()) as {
    seq: number; at: string; run_id: string | null; type: string; detail_json: string;
  }[];
  return rows.map((r) => ({ seq: r.seq, at: r.at, runId: r.run_id, type: r.type, detail: JSON.parse(r.detail_json) }));
}

/** V3 CH-18: rows for one run's evidence package, including each row's chain hash. */
export type ChainedAuditRow = { seq: number; at: string; kind: string; resource: string | null; detail: unknown; entryHash: string | null };

export function appAuditForRun(db: Db, runId: string): ChainedAuditRow[] {
  return (db.prepare("SELECT seq, at, type, detail_json, entry_hash FROM app_audit WHERE run_id = ? ORDER BY seq").all(runId) as Array<{ seq: number; at: string; type: string; detail_json: string; entry_hash: string | null }>)
    .map((r) => ({ seq: r.seq, at: r.at, kind: r.type, resource: null, detail: JSON.parse(r.detail_json), entryHash: r.entry_hash }));
}

/** EHR audit rows about the given resources inside a time window (inclusive). */
export function ehrAuditForResources(db: Db, resources: string[], from: string, to: string): ChainedAuditRow[] {
  if (!resources.length) return [];
  return (db.prepare(`SELECT seq, at, action, resource, detail_json, entry_hash FROM ehr_audit WHERE resource IN (${resources.map(() => "?").join(",")}) AND at >= ? AND at <= ? ORDER BY seq`).all(...resources, from, to) as Array<{ seq: number; at: string; action: string; resource: string; detail_json: string; entry_hash: string | null }>)
    .map((r) => ({ seq: r.seq, at: r.at, kind: r.action, resource: r.resource, detail: JSON.parse(r.detail_json), entryHash: r.entry_hash }));
}
