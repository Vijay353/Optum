/**
 * Local durable persistence (SQLite via Node's built-in node:sqlite).
 *
 * One SQLite file, schema-separated by owner prefix:
 *   ehr_*    — Mock Provider EHR / FHIR server
 *   payer_*  — Mock Provider Access (payer) server
 *   hie_*    — Mock HIE document server
 *   policy_* — Synthetic policy service
 *   app_*    — EvidenceBridge orchestrator (runs, audit, imports)
 *   sim_*    — simulator control plane (fault injection)
 *
 * Each module touches only its own prefix. A single file lets the Data Studio
 * commit an import atomically across simulators — a demo convenience that real,
 * independent systems would not offer (documented in DECISION-LOG.md).
 */
import { DatabaseSync } from "node:sqlite";
import { systemClock, type Clock } from "../domain/clock";
import { migrateAuditChain } from "./auditChain";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ehr_patients (
  id TEXT PRIMARY KEY, age_band TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ehr_coverage (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES ehr_patients(id),
  plan_name TEXT NOT NULL, plan_type TEXT NOT NULL, payer_org_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ehr_service_requests (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES ehr_patients(id),
  coverage_id TEXT NOT NULL REFERENCES ehr_coverage(id),
  description TEXT NOT NULL, service_category TEXT NOT NULL,
  requested_date TEXT NOT NULL, ordering_org_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ehr_prior_auth_drafts (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK (version > 0),
  service_request_id TEXT NOT NULL REFERENCES ehr_service_requests(id),
  patient_id TEXT NOT NULL REFERENCES ehr_patients(id),
  coverage_id TEXT NOT NULL REFERENCES ehr_coverage(id),
  policy_version TEXT NOT NULL,
  business_status TEXT NOT NULL CHECK (business_status IN ('DRAFT_INCOMPLETE','EVIDENCE_REVIEW_PENDING')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ehr_documents (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES ehr_patients(id),
  type TEXT NOT NULL, title TEXT NOT NULL, date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ehr_tasks (
  id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES ehr_prior_auth_drafts(id),
  idempotency_key TEXT NOT NULL UNIQUE, resource_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ehr_idempotency (
  key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ehr_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, resource TEXT NOT NULL, detail_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ehr_outbox (
  event_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, payload_json TEXT NOT NULL,
  emitted_at TEXT NOT NULL, delivery_count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS payer_attribution (
  patient_id TEXT NOT NULL, provider_org_id TEXT NOT NULL, attributed INTEGER NOT NULL,
  treatment_relationship TEXT NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT,
  PRIMARY KEY (patient_id, provider_org_id)
);
CREATE TABLE IF NOT EXISTS payer_opt_out (
  patient_id TEXT PRIMARY KEY, opted_out INTEGER NOT NULL, recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payer_eob (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, provider_org_id TEXT NOT NULL, provider_name TEXT NOT NULL,
  service_date TEXT NOT NULL, code TEXT NOT NULL, code_display TEXT NOT NULL,
  outcome TEXT NOT NULL, adjudicated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payer_access_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, method TEXT NOT NULL,
  path TEXT NOT NULL, client TEXT NOT NULL, status INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hie_documents (
  id TEXT PRIMARY KEY, indexed_patient_id TEXT NOT NULL, match_confidence TEXT NOT NULL CHECK (match_confidence IN ('exact','probable')),
  author_org_id TEXT NOT NULL, author_name TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
  date TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  content_type TEXT NOT NULL, hash_sha256 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hie_binaries (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL UNIQUE REFERENCES hie_documents(id), content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hie_access_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, method TEXT NOT NULL,
  path TEXT NOT NULL, client TEXT NOT NULL, status INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_versions (
  policy_version TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('active','retired')),
  service_category TEXT NOT NULL, label TEXT NOT NULL, effective_from TEXT NOT NULL,
  effective_to TEXT, requirements_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_runs (
  run_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, draft_id TEXT NOT NULL,
  status TEXT NOT NULL, decision TEXT, outcome_state TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, run_id TEXT,
  type TEXT NOT NULL, detail_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_import_batches (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, filename TEXT NOT NULL, mode TEXT NOT NULL,
  sha256 TEXT NOT NULL, status TEXT NOT NULL, summary_json TEXT NOT NULL,
  staged_json TEXT, pre_snapshot_json TEXT
);
CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sim_faults (key TEXT PRIMARY KEY, config_json TEXT NOT NULL);
`;

/** Business tables that make up a resettable simulator dataset. */
export const DATASET_TABLES = [
  "ehr_patients",
  "ehr_coverage",
  "ehr_service_requests",
  "ehr_prior_auth_drafts",
  "ehr_documents",
  "payer_attribution",
  "payer_opt_out",
  "payer_eob",
  "hie_documents",
  "hie_binaries",
  "policy_versions",
] as const;

/** Runtime state cleared on scenario reset (not part of the editable dataset). */
export const RUNTIME_TABLES = [
  "ehr_tasks",
  "ehr_idempotency",
  "ehr_audit",
  "ehr_outbox",
  "payer_access_log",
  "hie_access_log",
  "app_runs",
  "app_audit",
  "sim_faults",
] as const;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 3000;");
  db.exec(SCHEMA);
  migrateAuditChain(db);
  return db;
}

/** Run fn inside a single IMMEDIATE transaction; rolls back on any throw. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const clocks = new WeakMap<Db, Clock>();

/** Binds the clock that business timestamps for this database use (V3 CH-0B). */
export function bindClock(db: Db, clock: Clock): void {
  clocks.set(db, clock);
}

export function clockOf(db: Db): Clock {
  return clocks.get(db) ?? systemClock;
}

/** Current business time for this database, ISO 8601 UTC. */
export function nowIso(db: Db): string {
  return clockOf(db).now().toISOString();
}
