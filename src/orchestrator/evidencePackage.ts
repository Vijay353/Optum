/**
 * Audit evidence package (V3 CH-18). One JSON export per run, built only from
 * persisted records. Not a compliance certification. The digest is a SHA-256
 * checksum of the canonical JSON, not a digital signature. Document text is
 * never included: facts carry values and offsets, and the document is
 * referenced by id and hash.
 */
import { canonicalJson, sha256Hex } from "../domain/integrity";
import type { Db } from "../persistence/db";
import { nowIso } from "../persistence/db";
import { verifyChain, type ChainReport } from "../persistence/auditChain";
import { appAuditForRun, ehrAuditForResources } from "../persistence/auditStore";
import { evidenceChecks } from "./evidenceChecks";
import type { Run } from "./runTypes";

export const PACKAGE_SCHEMA_VERSION = "EB-EVIDENCE-PACKAGE-1";

export type EvidencePackage = Record<string, unknown> & {
  schemaVersion: string;
  evidenceStatus: "complete" | "partial" | "unverifiable";
  missing: string[];
  digest: { algorithm: "sha256"; over: string; value: string };
};

export function buildEvidencePackage(db: Db, run: Run, exportedBy: { role: string }): EvidencePackage {
  const taskId = run.execution.result?.taskId ?? null;
  const app = appAuditForRun(db, run.runId);
  const resources = [`Draft/${run.event.draftId}`, ...(taskId ? [`Task/${taskId}`] : [])];
  const from = run.event.occurredAt < run.createdAt ? run.event.occurredAt : run.createdAt;
  const ehr = ehrAuditForResources(db, resources, from, run.updatedAt);
  const chains: ChainReport[] = [verifyChain(db, "app_audit"), verifyChain(db, "ehr_audit")];

  const missing: string[] = [];
  if (!run.policyResult) missing.push("The run ended before a policy decision.");
  if (run.status === "EVALUATING" || run.status === "EXECUTING") missing.push("The run is still in progress.");
  if (run.context && run.context.policy.effectiveFrom === undefined) missing.push("The coverage policy snapshot has no effective dates (recorded before V3 CH-16).");
  if (run.execution.result && !run.execution.readback?.verified) missing.push("A task was written but its read-back is missing or did not match.");
  const unverifiable =
    chains.some((c) => c.status === "TAMPERED") || [...app, ...ehr].some((r) => r.entryHash === null);
  const evidenceStatus: EvidencePackage["evidenceStatus"] = unverifiable ? "unverifiable" : missing.length ? "partial" : "complete";
  if (unverifiable) missing.push("The audit chain did not verify, or included rows have no hash.");

  const body = {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    name: "Audit evidence package",
    notice: "Synthetic data only. Not a compliance certification. The digest is a checksum, not a signature. Demo identity is not authentication.",
    exportedAt: nowIso(db),
    exportedBy: { role: exportedBy.role, demoIdentity: true },
    evidenceStatus,
    missing,
    run: { runId: run.runId, status: run.status, outcomeState: run.outcomeState, createdAt: run.createdAt, updatedAt: run.updatedAt, deliveryCount: run.deliveryCount },
    event: run.event,
    draft: {
      id: run.event.draftId,
      versionAtEvent: run.event.draftVersion,
      statusBefore: run.execution.stateChange?.from ?? run.context?.draft.businessStatus ?? null,
      statusAfter: run.execution.readback?.draftStatusAfter ?? null,
      versionAfter: run.execution.readback?.draftVersionAfter ?? null,
    },
    decision: run.policyResult
      ? { engineVersion: run.policyResult.policyVersion, decision: run.policyResult.decision, ruleId: run.policyResult.ruleId, reasons: run.policyResult.reasons, recordedInput: run.policyInput }
      : null,
    coveragePolicyAtDecision: run.context?.policy ?? null,
    access: { atEvaluation: run.access, beforeWrite: run.execution.preWriteCheck ?? null },
    claimLeads: run.claims ? { providerOrgId: run.claims.providerOrgId, firstDate: run.claims.firstDate, lastDate: run.claims.lastDate, lineCount: run.claims.leadCount, eobIds: [...new Set(run.claims.leads.map((l) => l.id))] } : null,
    externalDocuments: {
      candidates: run.candidates ?? null,
      selected: run.document
        ? { id: run.document.id, author: run.document.authorOrgId, date: run.document.date, declaredSha256: run.document.declaredSha256, computedSha256: run.document.computedSha256, hashVerified: run.document.hashVerified }
        : null,
      patientMatch: run.patientMatch,
    },
    extraction: run.extraction
      ? {
          extractor: run.extraction.extractor,
          extractionHash: run.extraction.extractionHash,
          skippedReason: run.extraction.skippedReason ?? null,
          validationIssues: run.extraction.validationIssues,
          facts: (run.extraction.output?.facts ?? []).map((f) => ({ field: f.field, value: f.normalizedValue, page: f.sourcePage, start: f.sourceStart, end: f.sourceEnd })),
          sourceTextIncluded: false,
        }
      : null,
    evidenceChecks: evidenceChecks(run),
    write: {
      confirmedBy: run.execution.confirmedBy,
      toolCalls: run.execution.toolCalls,
      toolInput: run.stagedToolInput,
      toolResult: run.execution.result,
      error: run.execution.error,
      readback: run.execution.readback ? { verified: run.execution.readback.verified, checks: run.execution.readback.checks, taskId: run.execution.readback.task?.id ?? null } : null,
    },
    trace: run.trace.map((t) => ({ seq: t.seq, at: t.at, step: t.step, actor: t.actor, ok: t.ok, summary: t.summary, calls: t.calls })),
    audit: { app, ehr },
    auditChain: { reports: chains, includedRowSeqs: { app_audit: app.map((r) => r.seq), ehr_audit: ehr.map((r) => r.seq) } },
    verifyInstructions:
      "Remove the digest field, serialize the rest as canonical JSON (keys sorted, no spaces), and compute SHA-256. It must equal digest.value. Or run: npx tsx scripts/verifyEvidencePackage.ts <file>",
  };
  return { ...body, digest: { algorithm: "sha256", over: "canonical JSON of this package without the digest field", value: sha256Hex(canonicalJson(body)) } };
}

export function verifyPackageDigest(pkg: unknown): { ok: boolean; expected: string; actual: string | null } {
  if (!pkg || typeof pkg !== "object" || !("digest" in pkg)) return { ok: false, expected: "", actual: null };
  const { digest, ...rest } = pkg as { digest: { value?: unknown } };
  const expected = sha256Hex(canonicalJson(rest));
  const actual = typeof digest?.value === "string" ? digest.value : null;
  return { ok: actual === expected, expected, actual };
}

export function packageFilename(runId: string): string {
  return `evidence-package-${runId.replace(/[^A-Za-z0-9-]/g, "")}.json`;
}
