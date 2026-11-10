/** FHIR-like Task persistence owned by the mock EHR. */
import type { Db } from "./db";
import type { FhirTask } from "../domain/contracts";

export function insertTask(db: Db, task: FhirTask, draftId: string, idempotencyKey: string): void {
  db.prepare("INSERT INTO ehr_tasks (id, draft_id, idempotency_key, resource_json, created_at) VALUES (?,?,?,?,?)").run(
    task.id, draftId, idempotencyKey, JSON.stringify(task), task.authoredOn,
  );
}

export function getTask(db: Db, id: string): FhirTask | null {
  const row = db.prepare("SELECT resource_json FROM ehr_tasks WHERE id = ?").get(id) as { resource_json: string } | undefined;
  return row ? (JSON.parse(row.resource_json) as FhirTask) : null;
}

export function listTasksForDraft(db: Db, draftId: string): FhirTask[] {
  const rows = db.prepare("SELECT resource_json FROM ehr_tasks WHERE draft_id = ? ORDER BY created_at").all(draftId) as { resource_json: string }[];
  return rows.map((r) => JSON.parse(r.resource_json) as FhirTask);
}

export function countTasks(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM ehr_tasks").get() as { n: number }).n;
}

/** Deterministic, readable task id: TASK-EVID-<patient number>[-n]. */
export function nextTaskId(db: Db, patientId: string): string {
  const num = patientId.replace(/^SYN-PAT-/, "");
  const base = `TASK-EVID-${num}`;
  const exists = (id: string) => !!db.prepare("SELECT 1 FROM ehr_tasks WHERE id = ?").get(id);
  if (!exists(base)) return base;
  for (let i = 2; i < 10000; i++) if (!exists(`${base}-${i}`)) return `${base}-${i}`;
  throw new Error("task id space exhausted");
}

export type TaskSummary = { id: string; draftId: string; status: string; businessStatus: string; owner: string; focus: string; createdAt: string };

/** Flat list of all Tasks for the Data Studio browser and export (moved here from the route file in V3 CH-1). */
export function listTaskSummaries(db: Db): TaskSummary[] {
  const rows = db.prepare("SELECT id, draft_id, created_at, resource_json FROM ehr_tasks ORDER BY created_at").all() as {
    id: string; draft_id: string; created_at: string; resource_json: string;
  }[];
  return rows.map((t) => {
    const res = JSON.parse(t.resource_json) as FhirTask;
    return { id: t.id, draftId: t.draft_id, status: res.status, businessStatus: res.businessStatus.text, owner: res.owner.reference, focus: res.focus.reference, createdAt: t.created_at };
  });
}
