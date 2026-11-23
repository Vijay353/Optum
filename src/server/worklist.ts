/**
 * Product P3: the draft worklist. Read-only composition of reads that already
 * exist (the dataset store and the run store). No new table, no write, no
 * decision logic: the browser maps each row to a plain-language queue status.
 */
import type { Db } from "../persistence/db";
import { readDataset } from "../data/datasetStore";
import { latestRunForDraft, listRunSummariesForDraft } from "../persistence/runStore";

export type WorklistLatest = {
  runId: string;
  status: string;
  decision: string | null;
  outcomeState: string | null;
  createdAt: string;
  /** Set when the final check before writing refused the write. */
  refusal: string | null;
};

export type WorklistItem = {
  draftId: string;
  version: number;
  businessStatus: string;
  patientId: string;
  ageBand: string | null;
  service: string | null;
  policyVersion: string;
  updatedAt: string;
  /** The draft the active demo scenario is about. Used only to break ties in the default selection. */
  scenarioDraft: boolean;
  checks: number;
  latest: WorklistLatest | null;
};

export function buildWorklist(db: Db, opts: { scenarioDraftId: string | null }): WorklistItem[] {
  const ds = readDataset(db);
  const ageBand = new Map(ds.patients.map((p) => [p.id, p.ageBand as string]));
  const service = new Map(ds.service_requests.map((s) => [s.id, s.description]));
  return ds.prior_auth_drafts.map((d) => {
    const run = latestRunForDraft(db, d.id);
    return {
      draftId: d.id,
      version: d.version,
      businessStatus: d.businessStatus as string,
      patientId: d.patientId,
      ageBand: ageBand.get(d.patientId) ?? null,
      service: service.get(d.serviceRequestId) ?? null,
      policyVersion: d.policyVersion,
      updatedAt: d.updatedAt,
      scenarioDraft: d.id === opts.scenarioDraftId,
      checks: listRunSummariesForDraft(db, d.id).length,
      latest: run
        ? {
            runId: run.runId,
            status: run.status,
            decision: run.policyResult?.decision ?? null,
            outcomeState: run.outcomeState,
            createdAt: run.createdAt,
            refusal: run.execution.preWriteCheck?.refusal ?? null,
          }
        : null,
    };
  });
}
