/**
 * Canonical synthetic dataset contract shared by JSON fixtures, CSV and XLSX
 * import, the simulators and export. Schema version: EB-WB-1.0.
 */
import { z } from "zod";
import { AgeBand, DraftId, IsoDate, IsoDateTime, ServiceRequestId, SyntheticCoverageId, SyntheticPatientId } from "../domain/contracts";

export const DATASET_SCHEMA_VERSION = "EB-WB-1.0";

const OrgId = z.string().regex(/^SYN-ORG-[A-Z]+-\d{2,6}$/, "organization id must look like SYN-ORG-XX-000 (synthetic)");
const SafeText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !/\b\d{3}-\d{2}-\d{4}\b/.test(s), "looks like an SSN — real identifiers are not allowed")
    .refine((s) => !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(s), "looks like an email address — real identifiers are not allowed")
    .refine((s) => !/\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/.test(s), "looks like a phone number — real identifiers are not allowed");

export const PatientRow = z.strictObject({ id: SyntheticPatientId, ageBand: AgeBand });
export const CoverageRow = z.strictObject({
  id: SyntheticCoverageId,
  patientId: SyntheticPatientId,
  planName: SafeText(120),
  planType: z.enum(["MEDICARE_ADVANTAGE", "COMMERCIAL", "MEDICAID_MANAGED_CARE"]),
  payerOrgId: OrgId,
});
export const ServiceRequestRow = z.strictObject({
  id: ServiceRequestId,
  patientId: SyntheticPatientId,
  coverageId: SyntheticCoverageId,
  description: SafeText(200),
  serviceCategory: z.enum(["ELECTIVE_LUMBAR_PROCEDURE"]),
  requestedDate: IsoDate,
  orderingOrgId: OrgId,
});
export const PriorAuthDraftRow = z.strictObject({
  id: DraftId,
  version: z.number().int().positive(),
  serviceRequestId: ServiceRequestId,
  patientId: SyntheticPatientId,
  coverageId: SyntheticCoverageId,
  policyVersion: z.string().regex(/^SYN-[A-Z]+-PA-\d{4}-\d{2}$/, "policy version must be a synthetic id like SYN-SPINE-PA-2026-10"),
  businessStatus: z.literal("DRAFT_INCOMPLETE", {
    message: "businessStatus is system-managed; imports may only create DRAFT_INCOMPLETE drafts",
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export const AttributionRow = z.strictObject({
  patientId: SyntheticPatientId,
  providerOrgId: OrgId,
  attributed: z.boolean(),
  treatmentRelationship: z.enum(["ESTABLISHED", "PENDING", "NONE"]),
  effectiveFrom: IsoDate,
  effectiveTo: IsoDate.nullable(),
});
export const OptOutRow = z.strictObject({ patientId: SyntheticPatientId, optedOut: z.boolean(), recordedAt: IsoDateTime });
export const EobRow = z.strictObject({
  id: z.string().regex(/^EOB-[A-Z0-9-]{2,40}$/),
  patientId: SyntheticPatientId,
  providerOrgId: OrgId,
  providerName: SafeText(120),
  serviceDate: IsoDate,
  code: z.string().regex(/^[0-9A-Z]{4,7}$/),
  codeDisplay: SafeText(120),
  outcome: z.enum(["complete", "partial", "error", "queued"]),
  adjudicatedAt: IsoDateTime,
});
const DocBase = {
  id: z.string().regex(/^(EHR|HIE)-[A-Z0-9-]{2,40}$/),
  patientId: SyntheticPatientId.optional(),
  indexedPatientId: SyntheticPatientId.optional(),
  type: z.enum(["imaging-report", "pt-discharge-summary", "pt-progress-note", "office-note"]),
  title: SafeText(160),
  date: IsoDate,
};
export const EhrDocumentRow = z.strictObject({ source: z.literal("EHR"), ...DocBase, patientId: SyntheticPatientId });
export const HieDocumentRow = z.strictObject({
  source: z.literal("HIE"),
  ...DocBase,
  indexedPatientId: SyntheticPatientId,
  matchConfidence: z.enum(["exact", "probable"]),
  authorOrgId: OrgId,
  authorName: SafeText(120),
  periodStart: IsoDate,
  periodEnd: IsoDate,
  contentType: z.literal("text/plain"),
});
export const DocumentRow = z.discriminatedUnion("source", [EhrDocumentRow, HieDocumentRow]);
export const DocumentContentRow = z.strictObject({
  documentId: z.string().regex(/^HIE-[A-Z0-9-]{2,40}$/),
  page: z.number().int().min(1).max(50),
  text: z.string().min(1).max(30000),
});
export const PolicyRequirement = z.strictObject({
  code: z.enum(["SUPERVISED_PHYSICAL_THERAPY_DOCUMENTATION", "ADVANCED_IMAGING_REPORT"]),
  description: SafeText(200),
  localDocumentTypes: z.array(z.string()).min(1),
  externalDocumentTypes: z.array(z.string()),
  lookbackMonths: z.number().int().min(1).max(60),
});
export const PolicyVersionRow = z.strictObject({
  policyVersion: z.string().regex(/^SYN-[A-Z]+-PA-\d{4}-\d{2}$/),
  status: z.enum(["active", "retired"]),
  serviceCategory: z.enum(["ELECTIVE_LUMBAR_PROCEDURE"]),
  label: SafeText(240).refine((s) => s.startsWith("SYNTHETIC"), "policy label must begin with SYNTHETIC"),
  effectiveFrom: IsoDate,
  effectiveTo: IsoDate.nullable(),
  requirements: z.array(PolicyRequirement).min(1),
});

export type Patient = z.infer<typeof PatientRow>;
export type Coverage = z.infer<typeof CoverageRow>;
export type ServiceRequest = z.infer<typeof ServiceRequestRow>;
export type PriorAuthDraft = Omit<z.infer<typeof PriorAuthDraftRow>, "businessStatus"> & { businessStatus: "DRAFT_INCOMPLETE" | "EVIDENCE_REVIEW_PENDING" };
export type Attribution = z.infer<typeof AttributionRow>;
export type OptOut = z.infer<typeof OptOutRow>;
export type Eob = z.infer<typeof EobRow>;
export type EhrDocument = z.infer<typeof EhrDocumentRow>;
export type HieDocument = z.infer<typeof HieDocumentRow>;
export type DocumentRef = EhrDocument | HieDocument;
export type DocumentContent = z.infer<typeof DocumentContentRow>;
export type PolicyVersion = z.infer<typeof PolicyVersionRow>;

export type Dataset = {
  patients: Patient[];
  coverage: Coverage[];
  service_requests: ServiceRequest[];
  prior_auth_drafts: PriorAuthDraft[];
  provider_attribution: Attribution[];
  patient_opt_out: OptOut[];
  explanation_of_benefits: Eob[];
  document_references: DocumentRef[];
  document_contents: DocumentContent[];
  policy_requirements: PolicyVersion[];
};

export const ENTITY_KEYS = [
  "patients",
  "coverage",
  "service_requests",
  "prior_auth_drafts",
  "provider_attribution",
  "patient_opt_out",
  "explanation_of_benefits",
  "document_references",
  "document_contents",
  "policy_requirements",
] as const;
export type EntityKey = (typeof ENTITY_KEYS)[number];

export const ROW_SCHEMAS: Record<EntityKey, z.ZodType> = {
  patients: PatientRow,
  coverage: CoverageRow,
  service_requests: ServiceRequestRow,
  prior_auth_drafts: PriorAuthDraftRow,
  provider_attribution: AttributionRow,
  patient_opt_out: OptOutRow,
  explanation_of_benefits: EobRow,
  document_references: DocumentRow,
  document_contents: DocumentContentRow,
  policy_requirements: PolicyVersionRow,
};

/** Primary key for each entity (used for duplicates and merge diffs). */
export function primaryKey(entity: EntityKey, row: Record<string, unknown>): string {
  switch (entity) {
    case "provider_attribution":
      return `${row.patientId}|${row.providerOrgId}`;
    case "patient_opt_out":
      return String(row.patientId);
    case "document_contents":
      return `${row.documentId}|${row.page}`;
    case "policy_requirements":
      return String(row.policyVersion);
    default:
      return String(row.id);
  }
}

export type ValidationIssue = { sheet: EntityKey | "_meta" | "file"; row: number | null; column: string | null; message: string };

/**
 * Row-level schema validation + cross-entity checks.
 * `rows` are 1-based spreadsheet row numbers when available (header = row 1).
 */
export function validateDataset(
  raw: Record<EntityKey, Array<{ rowNumber: number; data: Record<string, unknown> }>>,
): { dataset: Dataset; issues: ValidationIssue[]; rejectedKeys: Record<EntityKey, Set<string>> } {
  const issues: ValidationIssue[] = [];
  const rejectedKeys = Object.fromEntries(ENTITY_KEYS.map((k) => [k, new Set<string>()])) as Record<EntityKey, Set<string>>;
  const out = Object.fromEntries(ENTITY_KEYS.map((k) => [k, [] as unknown[]])) as unknown as Dataset;

  for (const entity of ENTITY_KEYS) {
    const seen = new Map<string, number>();
    for (const { rowNumber, data } of raw[entity] ?? []) {
      const pk = primaryKey(entity, data);
      if (data.__invalid) {
        // Cell-level conversion errors were already reported by the parser.
        rejectedKeys[entity].add(pk);
        continue;
      }
      const parsed = ROW_SCHEMAS[entity].safeParse(data);
      if (!parsed.success) {
        for (const i of parsed.error.issues) {
          issues.push({ sheet: entity, row: rowNumber, column: i.path.length ? String(i.path[0]) : null, message: i.message });
        }
        rejectedKeys[entity].add(pk);
        continue;
      }
      if (seen.has(pk)) {
        issues.push({ sheet: entity, row: rowNumber, column: null, message: `duplicate primary key ${pk} (first seen on row ${seen.get(pk)})` });
        rejectedKeys[entity].add(pk);
        continue;
      }
      seen.set(pk, rowNumber);
      (out[entity] as unknown[]).push(parsed.data);
    }
  }

  // Cross-entity referential integrity and invariants. Iterates until stable so
  // that rejecting a parent row cascades to its dependents (no silent orphans).
  const rowOf = (entity: EntityKey, pk: string) => raw[entity]?.find((r) => primaryKey(entity, r.data) === pk)?.rowNumber ?? null;
  let changed = true;
  while (changed) {
    changed = false;
    const live = <K extends EntityKey>(k: K) =>
      (out[k] as Record<string, unknown>[]).filter((r) => !rejectedKeys[k].has(primaryKey(k, r))) as unknown as Dataset[K];
    const patients = new Set(live("patients").map((p) => p.id));
    const coverage = new Map(live("coverage").map((c) => [c.id, c]));
    const srs = new Map(live("service_requests").map((s) => [s.id, s]));
    const policies = new Set(live("policy_requirements").map((p) => p.policyVersion));
    const liveDocs = live("document_references");
    const liveContents = live("document_contents");
    const hieDocs = new Set(liveDocs.filter((d) => d.source === "HIE").map((d) => d.id));
    const orphan = (entity: EntityKey, pk: string, column: string, msg: string) => {
      if (rejectedKeys[entity].has(pk)) return;
      issues.push({ sheet: entity, row: rowOf(entity, pk), column, message: msg });
      rejectedKeys[entity].add(pk);
      changed = true;
    };

    for (const c of live("coverage")) if (!patients.has(c.patientId)) orphan("coverage", c.id, "patientId", `orphan reference: patient ${c.patientId} not found`);
    for (const s of live("service_requests")) {
      if (!patients.has(s.patientId)) orphan("service_requests", s.id, "patientId", `orphan reference: patient ${s.patientId} not found`);
      const cov = coverage.get(s.coverageId);
      if (!cov) orphan("service_requests", s.id, "coverageId", `orphan reference: coverage ${s.coverageId} not found`);
      else if (cov.patientId !== s.patientId) orphan("service_requests", s.id, "coverageId", `coverage ${s.coverageId} belongs to a different patient`);
    }
    for (const d of live("prior_auth_drafts")) {
      const sr = srs.get(d.serviceRequestId);
      if (!sr) orphan("prior_auth_drafts", d.id, "serviceRequestId", `orphan reference: service request ${d.serviceRequestId} not found`);
      else if (sr.patientId !== d.patientId || sr.coverageId !== d.coverageId) {
        orphan("prior_auth_drafts", d.id, "patientId", "draft patient/coverage must match its service request");
      }
      if (!policies.has(d.policyVersion)) orphan("prior_auth_drafts", d.id, "policyVersion", `orphan reference: policy ${d.policyVersion} not found`);
      if (d.updatedAt < d.createdAt) orphan("prior_auth_drafts", d.id, "updatedAt", "updatedAt is earlier than createdAt");
    }
    for (const a of live("provider_attribution")) {
      const pk = `${a.patientId}|${a.providerOrgId}`;
      if (!patients.has(a.patientId)) orphan("provider_attribution", pk, "patientId", `orphan reference: patient ${a.patientId} not found`);
      if (a.effectiveTo && a.effectiveTo < a.effectiveFrom) orphan("provider_attribution", pk, "effectiveTo", "effectiveTo is before effectiveFrom");
    }
    for (const o of live("patient_opt_out")) if (!patients.has(o.patientId)) orphan("patient_opt_out", o.patientId, "patientId", `orphan reference: patient ${o.patientId} not found`);
    for (const e of live("explanation_of_benefits")) if (!patients.has(e.patientId)) orphan("explanation_of_benefits", e.id, "patientId", `orphan reference: patient ${e.patientId} not found`);
    for (const d of liveDocs) {
      const pid = d.source === "EHR" ? d.patientId : d.indexedPatientId;
      if (!patients.has(pid)) orphan("document_references", d.id, d.source === "EHR" ? "patientId" : "indexedPatientId", `orphan reference: patient ${pid} not found`);
      if (d.source === "HIE" && d.periodEnd < d.periodStart) orphan("document_references", d.id, "periodEnd", "periodEnd is before periodStart");
      if (d.source === "HIE" && !liveContents.some((c) => c.documentId === d.id)) {
        orphan("document_references", d.id, "id", "HIE document has no content rows in document_contents");
      }
    }
    for (const c of liveContents) {
      if (!hieDocs.has(c.documentId)) orphan("document_contents", `${c.documentId}|${c.page}`, "documentId", `orphan reference: HIE document ${c.documentId} not found`);
    }
    for (const p of live("policy_requirements")) {
      if (p.effectiveTo && p.effectiveTo < p.effectiveFrom) orphan("policy_requirements", p.policyVersion, "effectiveTo", "effectiveTo is before effectiveFrom");
    }
  }

  // Drop rejected rows from the dataset so a commit never contains them.
  for (const entity of ENTITY_KEYS) {
    (out[entity] as unknown[]) = (out[entity] as Record<string, unknown>[]).filter((r) => !rejectedKeys[entity].has(primaryKey(entity, r)));
  }
  return { dataset: out, issues, rejectedKeys };
}

/** Joins per-page content rows into a single payload separated by form feeds. */
export function documentText(contents: DocumentContent[], documentId: string): string {
  return contents
    .filter((c) => c.documentId === documentId)
    .sort((a, b) => a.page - b.page)
    .map((c) => c.text)
    .join("\f");
}
