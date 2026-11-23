/**
 * Product P9: honest metrics. Every number is an aggregate of persisted run
 * records (app_runs); nothing is estimated here. Estimates (staff time) are
 * computed in the browser from these counts and an editable, labelled
 * assumption, never stored and never presented as observed.
 */
import type { Db } from "../persistence/db";
import type { Run } from "../orchestrator/runTypes";

export type Metrics = {
  /** Every evidence check made, including redeliveries and re-checks. */
  checksRun: number;
  /** Distinct drafts with at least one check. */
  draftsChecked: number;
  /** Latest decision per draft. Null decision = the check failed before a decision. */
  latestDecisions: Record<string, number>;
  /** Drafts whose latest check found outside evidence to review (waiting or staged). */
  evidenceFoundDrafts: number;
  /** Drafts whose latest check is waiting for a person to stage the task. */
  awaitingStaging: number;
  /** Distinct review tasks created and verified (idempotent replays counted once). */
  tasksStaged: number;
  /** Runs that reached read-back, and how many matched on every field. */
  readback: { attempted: number; verified: number };
  /** Writes refused by the final checks or by a version change. Nothing was written for these. */
  writesRefused: number;
  /** Average number of recorded trace steps, by latest decision. */
  avgTraceSteps: Record<string, number>;
  firstCheckAt: string | null;
  lastCheckAt: string | null;
};

export function computeMetrics(runs: Run[]): Metrics {
  const byDraft = new Map<string, Run>();
  for (const r of runs) {
    const cur = byDraft.get(r.event.draftId);
    if (!cur || r.createdAt >= cur.createdAt) byDraft.set(r.event.draftId, r);
  }
  const latest = [...byDraft.values()];
  const decisionOf = (r: Run) => r.policyResult?.decision ?? "NO_DECISION";

  const latestDecisions: Record<string, number> = {};
  const steps: Record<string, { n: number; sum: number }> = {};
  for (const r of latest) {
    const d = decisionOf(r);
    latestDecisions[d] = (latestDecisions[d] ?? 0) + 1;
    const s = (steps[d] ??= { n: 0, sum: 0 });
    s.n += 1;
    s.sum += r.trace.length;
  }

  const taskIds = new Set<string>();
  let attempted = 0;
  let verified = 0;
  let refused = 0;
  for (const r of runs) {
    if (r.status === "COMPLETED" && r.execution.result?.taskId) taskIds.add(r.execution.result.taskId);
    if (r.execution.readback) {
      attempted += 1;
      if (r.execution.readback.verified) verified += 1;
    }
    const attemptedWrite = !!r.execution.confirmedBy;
    if (attemptedWrite && (r.execution.preWriteCheck?.refusal || r.status === "REEVALUATION_REQUIRED")) refused += 1;
  }

  const times = runs.map((r) => r.createdAt).sort();
  return {
    checksRun: runs.length,
    draftsChecked: byDraft.size,
    latestDecisions,
    evidenceFoundDrafts: latest.filter((r) => decisionOf(r) === "REVIEW_EXTERNAL_EVIDENCE" && (r.status === "AWAITING_CONFIRMATION" || r.status === "COMPLETED" || r.status === "FAILED_RETRYABLE")).length,
    awaitingStaging: latest.filter((r) => r.status === "AWAITING_CONFIRMATION" || r.status === "FAILED_RETRYABLE").length,
    tasksStaged: taskIds.size,
    readback: { attempted, verified },
    writesRefused: refused,
    avgTraceSteps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, Math.round((v.sum / v.n) * 10) / 10])),
    firstCheckAt: times[0] ?? null,
    lastCheckAt: times[times.length - 1] ?? null,
  };
}

/** Reads app_runs only (this service's own table). */
export function readMetrics(db: Db): Metrics {
  const rows = db.prepare("SELECT run_json FROM app_runs ORDER BY created_at, rowid").all() as { run_json: string }[];
  return computeMetrics(rows.map((r) => JSON.parse(r.run_json) as Run));
}
