/** Browser API client. Holds no business state — everything is read from the server. */
import type { Run } from "../orchestrator/runTypes";
import type { EvidenceCheck } from "../orchestrator/evidenceChecks";
export type { EvidenceCheck };

export type Role = "pa-specialist" | "viewer" | "sim-admin";
let role: Role = "pa-specialist";
export const setRole = (r: Role) => { role = r; };
export const getRole = () => role;

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body: unknown) {
    super(message);
  }
}

/** CH-20: the server says the access session is missing or expired. Go back to the passcode screen, keeping the current place. */
function toGateIfExpired(status: number, body: unknown): void {
  if (status === 401 && (body as { gate?: unknown } | null)?.gate === true) {
    window.location.assign(`/gate?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }
}

async function req<T>(method: string, path: string, body?: unknown, raw?: Blob | ArrayBuffer): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      "x-demo-role": role,
      ...(raw ? { "content-type": "application/octet-stream" } : body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    toGateIfExpired(res.status, parsed);
    const msg = (parsed as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, msg, parsed);
  }
  return parsed as T;
}

export type Scenario = { id: string; order: number; title: string; description: string; draftId: string; expected: { decision: string; outcomeState: string; createsTask: boolean } };
export type Draft = { id: string; version: number; serviceRequestId: string; patientId: string; coverageId: string; policyVersion: string; businessStatus: string; updatedAt: string };
export type TaskRes = { id: string; status: string; businessStatus: { text: string }; owner: { reference: string }; focus: { reference: string }; authoredOn: string };
export type ClockState = { mode: "scenario" | "system"; now: string; anchor: string | null; offsetMs: number };
export type RunSummary = { runId: string; createdAt: string; eventId: string; deliveryCount: number; decision: string | null; outcomeState: string | null; status: string };
export type SourceHistory = { sourceOrgId: string; windowDays: number; draftsChecked: number; taskCreated: number; manualReview: number; waitingForStaging: number; noTaskOther: number };
export type TaskDue = { taskId: string; owner: string; state: "ON_TIME" | "DUE_SOON" | "OVERDUE"; dueAt: string; hoursLeft: number; hoursOverdue: number };
export type Workspace = { scenario: Scenario | null; draftId: string; draft: Draft | null; tasks: TaskRes[]; taskDue: TaskDue[]; sourceHistory: SourceHistory | null; runHistory: RunSummary[]; evidenceChecks: EvidenceCheck[]; limits: { maxRunAgeHours: number }; run: Run | null; faults: Record<string, unknown>; clock: ClockState };
export type Health = { ok: boolean; mode: string; extractor: string | null; configErrors: string[]; accessGate?: boolean; analytics?: import("./analytics").AnalyticsSettings };

export const apiClient = {
  health: () => req<Health>("GET", "/api/health"),
  scenarios: () => req<{ active: string | null; scenarios: Scenario[] }>("GET", "/api/scenarios"),
  loadScenario: (id: string) => req<{ active: string }>("POST", `/api/scenarios/${id}/load`),
  workspace: () => req<Workspace>("GET", "/api/workspace"),
  check: (draftId: string) => req<{ run: Run }>("POST", `/api/drafts/${draftId}/check`),
  stage: (runId: string) => req<{ run: Run }>("POST", `/api/runs/${runId}/stage`),
  advanceClock: (hours: number) => req<ClockState>("POST", "/api/clock/advance", { hours }),
  simulateEdit: (draftId: string) => req<{ draft: Draft }>("POST", `/api/drafts/${draftId}/simulate-edit`),
  evidencePackage: async (runId: string): Promise<{ text: string; status: string; missing: string[]; filename: string }> => {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/evidence-package`, { headers: { "x-demo-role": role } });
    const text = await res.text();
    if (!res.ok) {
      const err = JSON.parse(text) as { error?: string; gate?: boolean };
      toGateIfExpired(res.status, err);
      throw new ApiError(res.status, err.error ?? `Export failed (${res.status})`, null);
    }
    const body = JSON.parse(text) as { evidenceStatus: string; missing: string[] };
    const filename = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "evidence-package.json";
    return { text, status: body.evidenceStatus, missing: body.missing, filename };
  },
  verifyAudit: () => req<{ algorithm: string; limits: string; tables: Array<{ table: string; status: string; totalRows: number; legacyRows: number; hashedRows: number; firstBadSeq: number | null; reason: string }> }>("GET", "/api/audit/verify"),
  audit: (runId?: string) => req<{ app: unknown[]; ehr: unknown[] }>("GET", `/api/audit${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`),
  records: (entity: string, q: string) => req<{ entity: string; total: number; rows: Record<string, unknown>[] }>("GET", `/api/data/records?entity=${encodeURIComponent(entity)}&q=${encodeURIComponent(q)}`),
  importPreview: (file: File) => req<ImportPreview>("POST", `/api/data/import/preview?filename=${encodeURIComponent(file.name)}&mode=${importMode}`, undefined, file),
  importCommit: (batchId: string) => req<ImportCommitResult>("POST", `/api/data/import/${batchId}/commit`),
  imports: () => req<{ batches: ImportBatch[] }>("GET", "/api/data/imports"),
  restore: (batchId: string) => req<{ restored: string }>("POST", `/api/data/imports/${batchId}/restore`),
};

let importMode: "merge" | "replace" = "merge";
export const setImportMode = (m: "merge" | "replace") => { importMode = m; };

export type ImportIssue = { sheet: string; row: number | null; column: string | null; message: string };
export type ImportPreview = {
  batchId: string | null;
  filename: string;
  mode: "merge" | "replace";
  schemaVersion: string | null;
  canCommit: boolean;
  issues: ImportIssue[];
  diff: Record<string, { added: number; updated: number; unchanged: number; rejected: number; removed: number }>;
};
export type ImportCommitResult = { batchId: string; committed: boolean; verified: boolean; counts: Record<string, number> };
export type ImportBatch = { id: string; at: string; filename: string; mode: string; status: string; summary: Record<string, unknown> };
