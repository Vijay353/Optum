/**
 * Workbook schema EB-WB-1.0 — sheet and column definitions for XLSX/CSV
 * interchange. Excel is an interchange format only, never a system of record.
 */
import type { EntityKey } from "./dataset";

export type ColType = "string" | "int" | "bool" | "date" | "datetime" | "list" | "text";
export type ColumnSpec = {
  name: string;
  type: ColType;
  required: boolean;
  nullable?: boolean;
  allowed?: string[];
  editable: boolean; // false = system-managed (read-only in exports, ignored or rejected on import)
  description: string;
  example?: string;
};
export type SheetSpec = { sheet: EntityKey; owner: string; primaryKey: string; description: string; columns: ColumnSpec[] };

const c = (name: string, type: ColType, required: boolean, description: string, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({
  name, type, required, description, editable: true, ...extra,
});

export const WORKBOOK_SHEETS: SheetSpec[] = [
  {
    sheet: "patients", owner: "Mock EHR", primaryKey: "id", description: "Synthetic patients. Only an identifier and age band — no names, dates of birth or addresses.",
    columns: [
      c("id", "string", true, "Synthetic patient id SYN-PAT-#### (real identifiers are rejected)", { example: "SYN-PAT-1042" }),
      c("ageBand", "string", true, "Age band", { allowed: ["0-17", "18-34", "35-54", "55-64", "65+"], example: "55-64" }),
    ],
  },
  {
    sheet: "coverage", owner: "Mock EHR", primaryKey: "id", description: "Synthetic coverage records.",
    columns: [
      c("id", "string", true, "SYN-COV-####", { example: "SYN-COV-2208" }),
      c("patientId", "string", true, "FK → patients.id"),
      c("planName", "string", true, "Fictional plan name"),
      c("planType", "string", true, "Plan type", { allowed: ["MEDICARE_ADVANTAGE", "COMMERCIAL", "MEDICAID_MANAGED_CARE"] }),
      c("payerOrgId", "string", true, "Synthetic payer org SYN-ORG-PAYER-###"),
    ],
  },
  {
    sheet: "service_requests", owner: "Mock EHR", primaryKey: "id", description: "Procedure orders.",
    columns: [
      c("id", "string", true, "SR-#####"),
      c("patientId", "string", true, "FK → patients.id"),
      c("coverageId", "string", true, "FK → coverage.id (must belong to the same patient)"),
      c("description", "string", true, "Order description"),
      c("serviceCategory", "string", true, "Service category", { allowed: ["ELECTIVE_LUMBAR_PROCEDURE"] }),
      c("requestedDate", "date", true, "ISO date YYYY-MM-DD"),
      c("orderingOrgId", "string", true, "Synthetic ordering org"),
    ],
  },
  {
    sheet: "prior_auth_drafts", owner: "Mock EHR", primaryKey: "id", description: "Prior-authorization drafts. Updating a draft requires a higher version (optimistic concurrency).",
    columns: [
      c("id", "string", true, "PA-DRAFT-#####"),
      c("version", "int", true, "Positive integer revision; must increase on every content change"),
      c("serviceRequestId", "string", true, "FK → service_requests.id"),
      c("patientId", "string", true, "Must match the service request"),
      c("coverageId", "string", true, "Must match the service request"),
      c("policyVersion", "string", true, "FK → policy_requirements.policyVersion"),
      c("businessStatus", "string", true, "System-managed workflow state; imports may only use DRAFT_INCOMPLETE", { allowed: ["DRAFT_INCOMPLETE"] }),
      c("createdAt", "datetime", true, "ISO 8601 with timezone, e.g. 2026-10-16T14:00:00Z"),
      c("updatedAt", "datetime", true, "ISO 8601 with timezone; not before createdAt"),
    ],
  },
  {
    sheet: "provider_attribution", owner: "Mock Provider Access (payer)", primaryKey: "patientId + providerOrgId", description: "Payer-defined patient attribution.",
    columns: [
      c("patientId", "string", true, "FK → patients.id"),
      c("providerOrgId", "string", true, "Provider organization"),
      c("attributed", "bool", true, "TRUE/FALSE"),
      c("treatmentRelationship", "string", true, "Relationship", { allowed: ["ESTABLISHED", "PENDING", "NONE"] }),
      c("effectiveFrom", "date", true, "ISO date"),
      c("effectiveTo", "date", false, "ISO date or blank", { nullable: true }),
    ],
  },
  {
    sheet: "patient_opt_out", owner: "Mock Provider Access (payer)", primaryKey: "patientId", description: "Patient Provider Access opt-out choice.",
    columns: [
      c("patientId", "string", true, "FK → patients.id"),
      c("optedOut", "bool", true, "TRUE/FALSE"),
      c("recordedAt", "datetime", true, "ISO 8601 with timezone"),
    ],
  },
  {
    sheet: "explanation_of_benefits", owner: "Mock Provider Access (payer)", primaryKey: "id", description: "Adjudicated claim lines. Leads only — never clinical proof.",
    columns: [
      c("id", "string", true, "EOB-..."),
      c("patientId", "string", true, "FK → patients.id"),
      c("providerOrgId", "string", true, "Billing provider org"),
      c("providerName", "string", true, "Fictional provider name"),
      c("serviceDate", "date", true, "ISO date"),
      c("code", "string", true, "Procedure code (illustrative)"),
      c("codeDisplay", "string", true, "Display text"),
      c("outcome", "string", true, "Adjudication outcome", { allowed: ["complete", "partial", "error", "queued"] }),
      c("adjudicatedAt", "datetime", true, "ISO 8601 with timezone"),
    ],
  },
  {
    sheet: "document_references", owner: "Mock EHR (source=EHR) / Mock HIE (source=HIE)", primaryKey: "id", description: "Local chart document metadata and HIE-indexed external documents.",
    columns: [
      c("source", "string", true, "Owning system", { allowed: ["EHR", "HIE"] }),
      c("id", "string", true, "EHR-... or HIE-..."),
      c("patientId", "string", false, "EHR documents: FK → patients.id"),
      c("indexedPatientId", "string", false, "HIE documents: patient the HIE MPI linked this document to"),
      c("matchConfidence", "string", false, "HIE only: MPI correlation", { allowed: ["exact", "probable"] }),
      c("authorOrgId", "string", false, "HIE only: authoring org"),
      c("authorName", "string", false, "HIE only: fictional author name"),
      c("type", "string", true, "Document type", { allowed: ["imaging-report", "pt-discharge-summary", "pt-progress-note", "office-note"] }),
      c("title", "string", true, "Title"),
      c("date", "date", true, "ISO date"),
      c("periodStart", "date", false, "HIE only: care period start"),
      c("periodEnd", "date", false, "HIE only: care period end"),
      c("contentType", "string", false, "HIE only", { allowed: ["text/plain"] }),
      c("hashSha256", "string", false, "System-managed: computed from content on import (export only)", { editable: false }),
    ],
  },
  {
    sheet: "document_contents", owner: "Mock HIE", primaryKey: "documentId + page", description: "HIE document text, one row per page (cells hold plain text; formulas are rejected).",
    columns: [
      c("documentId", "string", true, "FK → document_references.id (HIE)"),
      c("page", "int", true, "1-based page number"),
      c("text", "text", true, "Plain page text (max 30,000 characters)"),
    ],
  },
  {
    sheet: "policy_requirements", owner: "Synthetic policy service", primaryKey: "policyVersion + requirementCode", description: "Fictional documentation checklist — one row per requirement. NOT InterQual.",
    columns: [
      c("policyVersion", "string", true, "e.g. SYN-SPINE-PA-2026-10"),
      c("status", "string", true, "Version status", { allowed: ["active", "retired"] }),
      c("serviceCategory", "string", true, "Service category", { allowed: ["ELECTIVE_LUMBAR_PROCEDURE"] }),
      c("label", "string", true, "Must begin with SYNTHETIC"),
      c("effectiveFrom", "date", true, "ISO date"),
      c("effectiveTo", "date", false, "ISO date or blank", { nullable: true }),
      c("requirementCode", "string", true, "Requirement", { allowed: ["SUPERVISED_PHYSICAL_THERAPY_DOCUMENTATION", "ADVANCED_IMAGING_REPORT"] }),
      c("requirementDescription", "string", true, "Description"),
      c("localDocumentTypes", "list", true, "Comma-separated document types that satisfy it locally"),
      c("externalDocumentTypes", "list", false, "Comma-separated external document types to search"),
      c("lookbackMonths", "int", true, "1–60"),
    ],
  },
];

export const LIMITS = { maxBytes: 2 * 1024 * 1024, maxRowsPerSheet: 2000, maxColumns: 30 };
