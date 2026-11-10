/** Orchestrator execution-run persistence (app_runs). */
import type { Db } from "./db";
import type { Run } from "../orchestrator/runTypes";

export function saveRun(db: Db, run: Run): void {
  db.prepare(
    `INSERT INTO app_runs (run_id, event_id, draft_id, status, decision, outcome_state, created_at, updated_at, run_json)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(run_id) DO UPDATE SET status=excluded.status, decision=excluded.decision, outcome_state=excluded.outcome_state,
     updated_at=excluded.updated_at, run_json=excluded.run_json`,
  ).run(
    run.runId, run.event.eventId, run.event.draftId, run.status, run.policyResult?.decision ?? null, run.outcomeState,
    run.createdAt, run.updatedAt, JSON.stringify(run),
  );
}

export function getRun(db: Db, runId: string): Run | null {
  const row = db.prepare("SELECT run_json FROM app_runs WHERE run_id = ?").get(runId) as { run_json: string } | undefined;
  return row ? (JSON.parse(row.run_json) as Run) : null;
}

export function latestRunForDraft(db: Db, draftId: string): Run | null {
  const row = db.prepare("SELECT run_json FROM app_runs WHERE draft_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(draftId) as { run_json: string } | undefined;
  return row ? (JSON.parse(row.run_json) as Run) : null;
}

export function listRuns(db: Db, limit = 50): Array<Pick<Run, "runId" | "status" | "createdAt"> & { draftId: string; eventId: string; decision: string | null }> {
  const rows = db.prepare("SELECT run_id, draft_id, event_id, status, decision, created_at FROM app_runs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as {
    run_id: string; draft_id: string; event_id: string; status: string; decision: string | null; created_at: string;
  }[];
  return rows.map((r) => ({ runId: r.run_id, draftId: r.draft_id, eventId: r.event_id, status: r.status as Run["status"], decision: r.decision, createdAt: r.created_at }));
}

export function countToolCallsForDraft(db: Db, draftId: string): number {
  const rows = db.prepare("SELECT run_json FROM app_runs WHERE draft_id = ?").all(draftId) as { run_json: string }[];
  return rows.reduce((n, r) => n + ((JSON.parse(r.run_json) as Run).execution.toolCalls ?? 0), 0);
}

export type RunSummary = { runId: string; createdAt: string; eventId: string; deliveryCount: number; decision: string | null; outcomeState: string | null; status: Run["status"] };

/** All checks for one draft, oldest first (V3 CH-11). Nothing is filtered or rewritten. */
export function listRunSummariesForDraft(db: Db, draftId: string): RunSummary[] {
  const rows = db.prepare("SELECT run_json FROM app_runs WHERE draft_id = ? ORDER BY created_at, rowid").all(draftId) as { run_json: string }[];
  return rows.map((r) => {
    const run = JSON.parse(r.run_json) as Run;
    return { runId: run.runId, createdAt: run.createdAt, eventId: run.event.eventId, deliveryCount: run.deliveryCount, decision: run.policyResult?.decision ?? null, outcomeState: run.outcomeState, status: run.status };
  });
}
