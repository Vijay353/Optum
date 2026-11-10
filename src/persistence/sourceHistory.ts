/**
 * Trailing history with an external source clinic (V3 CH-8).
 *
 * Counts this system's own past checks (app_runs), never external master data.
 * Counting rules, so totals reconcile and nothing is counted twice:
 *  - one unit = one draft; only its latest check for this clinic in the window counts
 *  - the current draft is excluded from its own history
 *  - a check belongs to a clinic when its claim leads pointed to that clinic
 *  - window: checks made in the last `days` days of business time, inclusive
 * Every counted draft lands in exactly one bucket.
 */
import type { Db } from "./db";
import type { Run } from "../orchestrator/runTypes";

export type SourceHistory = {
  sourceOrgId: string;
  windowDays: number;
  from: string;
  to: string;
  excludedDraftId: string | null;
  draftsChecked: number;
  taskCreated: number;
  manualReview: number;
  waitingForStaging: number;
  noTaskOther: number;
};

export function sourceHistory(db: Db, q: { sourceOrgId: string; now: Date; days?: number; excludeDraftId?: string | null }): SourceHistory {
  const days = q.days ?? 90;
  const to = q.now.toISOString();
  const from = new Date(q.now.getTime() - days * 86_400_000).toISOString();
  const rows = db.prepare("SELECT run_json FROM app_runs WHERE created_at >= ? AND created_at <= ? ORDER BY created_at, rowid").all(from, to) as { run_json: string }[];
  const latest = new Map<string, Run>();
  for (const r of rows) {
    const run = JSON.parse(r.run_json) as Run;
    if (run.claims?.providerOrgId !== q.sourceOrgId) continue;
    if (q.excludeDraftId && run.event.draftId === q.excludeDraftId) continue;
    latest.set(run.event.draftId, run); // rows are in time order, so the last one wins
  }
  const h: SourceHistory = {
    sourceOrgId: q.sourceOrgId, windowDays: days, from, to, excludedDraftId: q.excludeDraftId ?? null,
    draftsChecked: latest.size, taskCreated: 0, manualReview: 0, waitingForStaging: 0, noTaskOther: 0,
  };
  for (const run of latest.values()) {
    if (run.status === "COMPLETED") h.taskCreated++;
    else if (run.status === "AWAITING_CONFIRMATION" || run.status === "FAILED_RETRYABLE" || run.status === "EXECUTING") h.waitingForStaging++;
    else if (run.outcomeState === "MANUAL_REVIEW") h.manualReview++;
    else h.noTaskOther++;
  }
  return h;
}
