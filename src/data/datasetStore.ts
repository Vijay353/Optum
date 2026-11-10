/**
 * Reads/writes the canonical dataset into the simulator tables, plus JSON
 * fixture loading and snapshot/restore. Server-side only.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DATASET_TABLES, RUNTIME_TABLES, tx, type Db } from "../persistence/db";
import { clearAuditAnchors } from "../persistence/auditChain";
import { sha256Hex } from "../domain/integrity";
import {
  ENTITY_KEYS,
  documentText,
  validateDataset,
  type Dataset,
  type DocumentContent,
  type EntityKey,
  type ValidationIssue,
} from "./dataset";

type Row = Record<string, unknown>;
const b = (v: unknown) => (v ? 1 : 0);

export function readDataset(db: Db): Dataset {
  const all = (sql: string) => db.prepare(sql).all() as Row[];
  const hieDocs = all("SELECT * FROM hie_documents ORDER BY id");
  const binaries = all("SELECT document_id, content FROM hie_binaries ORDER BY document_id");
  const contents: DocumentContent[] = [];
  for (const bin of binaries) {
    String(bin.content)
      .split("\f")
      .forEach((text, i) => contents.push({ documentId: String(bin.document_id), page: i + 1, text }));
  }
  return {
    patients: all("SELECT * FROM ehr_patients ORDER BY id").map((r) => ({ id: String(r.id), ageBand: r.age_band as never })),
    coverage: all("SELECT * FROM ehr_coverage ORDER BY id").map((r) => ({
      id: String(r.id), patientId: String(r.patient_id), planName: String(r.plan_name), planType: r.plan_type as never, payerOrgId: String(r.payer_org_id),
    })),
    service_requests: all("SELECT * FROM ehr_service_requests ORDER BY id").map((r) => ({
      id: String(r.id), patientId: String(r.patient_id), coverageId: String(r.coverage_id), description: String(r.description),
      serviceCategory: r.service_category as never, requestedDate: String(r.requested_date), orderingOrgId: String(r.ordering_org_id),
    })),
    prior_auth_drafts: all("SELECT * FROM ehr_prior_auth_drafts ORDER BY id").map((r) => ({
      id: String(r.id), version: Number(r.version), serviceRequestId: String(r.service_request_id), patientId: String(r.patient_id),
      coverageId: String(r.coverage_id), policyVersion: String(r.policy_version), businessStatus: r.business_status as never,
      createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    })),
    provider_attribution: all("SELECT * FROM payer_attribution ORDER BY patient_id").map((r) => ({
      patientId: String(r.patient_id), providerOrgId: String(r.provider_org_id), attributed: !!r.attributed,
      treatmentRelationship: r.treatment_relationship as never, effectiveFrom: String(r.effective_from), effectiveTo: (r.effective_to as string | null) ?? null,
    })),
    patient_opt_out: all("SELECT * FROM payer_opt_out ORDER BY patient_id").map((r) => ({
      patientId: String(r.patient_id), optedOut: !!r.opted_out, recordedAt: String(r.recorded_at),
    })),
    explanation_of_benefits: all("SELECT * FROM payer_eob ORDER BY id").map((r) => ({
      id: String(r.id), patientId: String(r.patient_id), providerOrgId: String(r.provider_org_id), providerName: String(r.provider_name),
      serviceDate: String(r.service_date), code: String(r.code), codeDisplay: String(r.code_display), outcome: r.outcome as never, adjudicatedAt: String(r.adjudicated_at),
    })),
    document_references: [
      ...all("SELECT * FROM ehr_documents ORDER BY id").map((r) => ({
        source: "EHR" as const, id: String(r.id), patientId: String(r.patient_id), type: r.type as never, title: String(r.title), date: String(r.date),
      })),
      ...hieDocs.map((r) => ({
        source: "HIE" as const, id: String(r.id), indexedPatientId: String(r.indexed_patient_id), matchConfidence: r.match_confidence as never,
        authorOrgId: String(r.author_org_id), authorName: String(r.author_name), type: r.type as never, title: String(r.title), date: String(r.date),
        periodStart: String(r.period_start), periodEnd: String(r.period_end), contentType: "text/plain" as const,
      })),
    ],
    document_contents: contents,
    policy_requirements: all("SELECT * FROM policy_versions ORDER BY policy_version").map((r) => ({
      policyVersion: String(r.policy_version), status: r.status as never, serviceCategory: r.service_category as never, label: String(r.label),
      effectiveFrom: String(r.effective_from), effectiveTo: (r.effective_to as string | null) ?? null, requirements: JSON.parse(String(r.requirements_json)),
    })),
  };
}

/** Upsert every row of the dataset. Caller wraps in a transaction. */
function upsertAll(db: Db, ds: Dataset): void {
  const run = (sql: string, ...args: (string | number | null)[]) => db.prepare(sql).run(...args);
  for (const p of ds.patients) run("INSERT INTO ehr_patients (id, age_band) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET age_band=excluded.age_band", p.id, p.ageBand);
  for (const c of ds.coverage) {
    run(`INSERT INTO ehr_coverage (id, patient_id, plan_name, plan_type, payer_org_id) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET patient_id=excluded.patient_id, plan_name=excluded.plan_name, plan_type=excluded.plan_type, payer_org_id=excluded.payer_org_id`,
      c.id, c.patientId, c.planName, c.planType, c.payerOrgId);
  }
  for (const s of ds.service_requests) {
    run(`INSERT INTO ehr_service_requests (id, patient_id, coverage_id, description, service_category, requested_date, ordering_org_id) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET patient_id=excluded.patient_id, coverage_id=excluded.coverage_id, description=excluded.description,
         service_category=excluded.service_category, requested_date=excluded.requested_date, ordering_org_id=excluded.ordering_org_id`,
      s.id, s.patientId, s.coverageId, s.description, s.serviceCategory, s.requestedDate, s.orderingOrgId);
  }
  for (const d of ds.prior_auth_drafts) {
    run(`INSERT INTO ehr_prior_auth_drafts (id, version, service_request_id, patient_id, coverage_id, policy_version, business_status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET version=excluded.version, service_request_id=excluded.service_request_id, patient_id=excluded.patient_id,
         coverage_id=excluded.coverage_id, policy_version=excluded.policy_version, business_status=excluded.business_status, updated_at=excluded.updated_at`,
      d.id, d.version, d.serviceRequestId, d.patientId, d.coverageId, d.policyVersion, d.businessStatus, d.createdAt, d.updatedAt);
  }
  for (const a of ds.provider_attribution) {
    run(`INSERT INTO payer_attribution (patient_id, provider_org_id, attributed, treatment_relationship, effective_from, effective_to) VALUES (?,?,?,?,?,?)
         ON CONFLICT(patient_id, provider_org_id) DO UPDATE SET attributed=excluded.attributed, treatment_relationship=excluded.treatment_relationship,
         effective_from=excluded.effective_from, effective_to=excluded.effective_to`,
      a.patientId, a.providerOrgId, b(a.attributed), a.treatmentRelationship, a.effectiveFrom, a.effectiveTo);
  }
  for (const o of ds.patient_opt_out) {
    run(`INSERT INTO payer_opt_out (patient_id, opted_out, recorded_at) VALUES (?,?,?)
         ON CONFLICT(patient_id) DO UPDATE SET opted_out=excluded.opted_out, recorded_at=excluded.recorded_at`, o.patientId, b(o.optedOut), o.recordedAt);
  }
  for (const e of ds.explanation_of_benefits) {
    run(`INSERT INTO payer_eob (id, patient_id, provider_org_id, provider_name, service_date, code, code_display, outcome, adjudicated_at) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET patient_id=excluded.patient_id, provider_org_id=excluded.provider_org_id, provider_name=excluded.provider_name,
         service_date=excluded.service_date, code=excluded.code, code_display=excluded.code_display, outcome=excluded.outcome, adjudicated_at=excluded.adjudicated_at`,
      e.id, e.patientId, e.providerOrgId, e.providerName, e.serviceDate, e.code, e.codeDisplay, e.outcome, e.adjudicatedAt);
  }
  for (const d of ds.document_references) {
    if (d.source === "EHR") {
      run(`INSERT INTO ehr_documents (id, patient_id, type, title, date) VALUES (?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET patient_id=excluded.patient_id, type=excluded.type, title=excluded.title, date=excluded.date`,
        d.id, d.patientId, d.type, d.title, d.date);
    } else {
      const text = documentText(ds.document_contents, d.id);
      const hash = sha256Hex(text);
      run(`INSERT INTO hie_documents (id, indexed_patient_id, match_confidence, author_org_id, author_name, type, title, date, period_start, period_end, content_type, hash_sha256)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET indexed_patient_id=excluded.indexed_patient_id, match_confidence=excluded.match_confidence, author_org_id=excluded.author_org_id,
           author_name=excluded.author_name, type=excluded.type, title=excluded.title, date=excluded.date, period_start=excluded.period_start,
           period_end=excluded.period_end, content_type=excluded.content_type, hash_sha256=excluded.hash_sha256`,
        d.id, d.indexedPatientId, d.matchConfidence, d.authorOrgId, d.authorName, d.type, d.title, d.date, d.periodStart, d.periodEnd, d.contentType, hash);
      run(`INSERT INTO hie_binaries (id, document_id, content) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content`, `BIN-${d.id}`, d.id, text);
    }
  }
  for (const p of ds.policy_requirements) {
    run(`INSERT INTO policy_versions (policy_version, status, service_category, label, effective_from, effective_to, requirements_json) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(policy_version) DO UPDATE SET status=excluded.status, service_category=excluded.service_category, label=excluded.label,
         effective_from=excluded.effective_from, effective_to=excluded.effective_to, requirements_json=excluded.requirements_json`,
      p.policyVersion, p.status, p.serviceCategory, p.label, p.effectiveFrom, p.effectiveTo, JSON.stringify(p.requirements));
  }
}

function clearTables(db: Db, tables: readonly string[]): void {
  // Delete children before parents.
  const order = [...tables].sort((a, b) => childRank(b) - childRank(a));
  for (const t of order) db.exec(`DELETE FROM ${t}`);
}
function childRank(t: string): number {
  return (
    {
      ehr_tasks: 9, ehr_outbox: 8, hie_binaries: 8, ehr_prior_auth_drafts: 7, ehr_service_requests: 6, ehr_documents: 6,
      ehr_coverage: 5, ehr_patients: 1,
    } as Record<string, number>
  )[t] ?? 3;
}

/** Replace: wipe dataset + runtime state then insert. Merge: upsert only. Atomic. */
export function writeDataset(db: Db, ds: Dataset, mode: "replace" | "merge"): void {
  tx(db, () => {
    if (mode === "replace") {
      clearTables(db, [...RUNTIME_TABLES, ...DATASET_TABLES]);
      clearAuditAnchors(db); // CH-17: the audit tables were cleared, so their head anchors go too
    }
    upsertAll(db, ds);
  });
}

export function snapshotDataset(db: Db): string {
  return JSON.stringify(readDataset(db));
}

/**
 * Restore a pre-import snapshot. Restore is a full replace: runtime state
 * (tasks, runs, audit, faults) is cleared too, so no task can reference a
 * draft that no longer exists. The UI states this before confirming.
 */
export function restoreSnapshot(db: Db, snapshot: string): void {
  writeDataset(db, JSON.parse(snapshot) as Dataset, "replace");
}

// ---------------------------------------------------------------------------
// JSON fixtures
// ---------------------------------------------------------------------------
/**
 * Loads a fixture dataset. Extra directories are overlays (V3 CH-6): their rows
 * are added after the base rows and the combined set is validated together, so
 * opt-in scenarios can add records without changing the base fixture.
 */
export function loadFixtureDataset(dirOrDirs: string | string[]): { dataset: Dataset; issues: ValidationIssue[] } {
  const dirs = Array.isArray(dirOrDirs) ? dirOrDirs : [dirOrDirs];
  const read = (name: string): Row[] =>
    dirs.flatMap((dir) => {
      const p = join(dir, `${name}.json`);
      return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Row[]) : [];
    });
  const raw = Object.fromEntries(
    ENTITY_KEYS.filter((k) => k !== "document_contents").map((k) => [k, read(k).map((data, i) => ({ rowNumber: i + 1, data }))]),
  ) as Record<EntityKey, Array<{ rowNumber: number; data: Row }>>;
  const contents: Array<{ rowNumber: number; data: Row }> = [];
  for (const docsDir of dirs.map((d) => join(d, "documents")).filter((d) => existsSync(d))) {
    for (const f of readdirSync(docsDir).filter((f) => f.endsWith(".txt")).sort()) {
      const id = f.replace(/\.txt$/, "");
      readFileSync(join(docsDir, f), "utf8")
        .split("\f")
        .forEach((text, i) => contents.push({ rowNumber: contents.length + 1, data: { documentId: id, page: i + 1, text } }));
    }
  }
  raw.document_contents = contents;
  const { dataset, issues } = validateDataset(raw);
  return { dataset, issues };
}

/** SHA-256 of each HIE document payload, for exports (moved here from the route file in V3 CH-1). */
export function readHieHashes(db: Db): Record<string, string> {
  const rows = db.prepare("SELECT id, hash_sha256 FROM hie_documents").all() as { id: string; hash_sha256: string }[];
  return Object.fromEntries(rows.map((h) => [h.id, h.hash_sha256]));
}
