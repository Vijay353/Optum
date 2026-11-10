/**
 * Shared simulator plumbing: demo client credentials + scopes, fault
 * injection and request logging. These are LOCAL DEMO credentials only —
 * not production authentication.
 */
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Db } from "../persistence/db";
import { nowIso } from "../persistence/db";

export type Scope =
  | "Patient.read"
  | "ServiceRequest.read"
  | "Coverage.read"
  | "DocumentReference.read"
  | "Draft.read"
  | "Draft.write"
  | "Draft.emit"
  | "Task.read"
  | "Task.write"
  | "ProviderAccess.read"
  | "Claims.read"
  | "HIE.read"
  | "Policy.read"
  | "Admin.read"
  /** V3 CH-1: SIMULATED-only probe of a simulator's own request log. */
  | "SimProbe.read";

export type DemoClient = { clientId: string; scopes: Scope[]; actingOrg?: string };

/** Static local tokens. Labelled demo credentials; no secret value. */
export const DEMO_CLIENTS: Record<string, DemoClient> = {
  "eb-orchestrator-local": {
    clientId: "evidencebridge-orchestrator",
    actingOrg: "SYN-ORG-ORTHO-100",
    // Minimum scopes: reads + Task write. No Draft.write, no DocumentReference write, no payer submission scope exists.
    scopes: ["Patient.read", "ServiceRequest.read", "Coverage.read", "DocumentReference.read", "Draft.read", "Task.read", "Task.write", "ProviderAccess.read", "Claims.read", "HIE.read", "Policy.read", "SimProbe.read"],
  },
  "eb-ehr-workflow-local": { clientId: "ehr-workflow-engine", scopes: ["Draft.read", "Draft.emit"] },
  "eb-demo-clinician-local": { clientId: "demo-clinician-ui", scopes: ["Draft.read", "Draft.write"] },
  "eb-sim-admin-local": { clientId: "simulator-admin", scopes: ["Admin.read", "Draft.read", "Task.read"] },
};

export const ORCHESTRATOR_TOKEN = "eb-orchestrator-local";
export const EHR_WORKFLOW_TOKEN = "eb-ehr-workflow-local";
export const DEMO_CLINICIAN_TOKEN = "eb-demo-clinician-local";
export const SIM_ADMIN_TOKEN = "eb-sim-admin-local";

export function clientOf(req: Request): DemoClient | null {
  const auth = req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/.exec(auth);
  return m ? DEMO_CLIENTS[m[1]!.trim()] ?? null : null;
}

export function requireScope(scope: Scope) {
  return (req: Request, res: Response, next: NextFunction) => {
    const client = clientOf(req);
    if (!client) return void res.status(401).json(operationOutcome("security", "missing or unknown bearer token"));
    if (!client.scopes.includes(scope)) return void res.status(403).json(operationOutcome("forbidden", `client ${client.clientId} lacks scope ${scope}`));
    res.locals.client = client;
    next();
  };
}

export function operationOutcome(code: string, diagnostics: string, extra: Record<string, unknown> = {}) {
  return { resourceType: "OperationOutcome", issue: [{ severity: "error", code, diagnostics }], ...extra };
}

// ---------------------------------------------------------------------------
// Fault injection
// ---------------------------------------------------------------------------
export type FaultConfig = {
  kind: "timeout" | "status" | "latency" | "behavior";
  status?: number;
  delayMs?: number;
  /** Number of times the fault fires; null/undefined = every time. */
  remaining?: number | null;
  note?: string;
};

/** Runtime schema for fault configs sent to the control API (V3 CH-2). */
export const FaultConfigSchema = z.strictObject({
  kind: z.enum(["timeout", "status", "latency", "behavior"]),
  status: z.number().int().min(400).max(599).optional(),
  delayMs: z.number().int().min(0).max(30_000).optional(),
  remaining: z.number().int().positive().nullable().optional(),
  note: z.string().max(200).optional(),
});

export const FAULT_POINTS = [
  "payer.authorization",
  "payer.probe",
  "payer.eob",
  "hie.search",
  "hie.binary",
  "ehr.read",
  "ehr.task.create",
  "ehr.task.read",
] as const;
export const BEHAVIOR_FAULTS = [
  "hie.binary.corrupt",
  "ehr.task.concurrentEdit",
  "ehr.task.dropResponseAfterCommit",
  "ehr.task.readbackMismatch",
] as const;
export type FaultKey = (typeof FAULT_POINTS)[number] | (typeof BEHAVIOR_FAULTS)[number];

export function setFault(db: Db, key: FaultKey, cfg: FaultConfig | null): void {
  if (!cfg) db.prepare("DELETE FROM sim_faults WHERE key = ?").run(key);
  else db.prepare("INSERT INTO sim_faults (key, config_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET config_json = excluded.config_json").run(key, JSON.stringify(cfg));
}

export function listFaults(db: Db): Record<string, FaultConfig> {
  const rows = db.prepare("SELECT key, config_json FROM sim_faults").all() as { key: string; config_json: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.config_json) as FaultConfig]));
}

/** Returns the fault if armed and consumes one firing. */
export function takeFault(db: Db, key: FaultKey): FaultConfig | null {
  const row = db.prepare("SELECT config_json FROM sim_faults WHERE key = ?").get(key) as { config_json: string } | undefined;
  if (!row) return null;
  const cfg = JSON.parse(row.config_json) as FaultConfig;
  if (typeof cfg.remaining === "number") {
    if (cfg.remaining <= 1) db.prepare("DELETE FROM sim_faults WHERE key = ?").run(key);
    else setFault(db, key, { ...cfg, remaining: cfg.remaining - 1 });
  }
  return cfg;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Applies a transport fault. Returns true if the response was already sent. */
export async function applyTransportFault(db: Db, key: FaultKey, res: Response): Promise<boolean> {
  const f = takeFault(db, key);
  if (!f) return false;
  if (f.kind === "latency") {
    await sleep(f.delayMs ?? 200);
    return false;
  }
  if (f.kind === "timeout") {
    await sleep(f.delayMs ?? 4000);
    if (!res.headersSent) res.status(504).json(operationOutcome("timeout", `simulated timeout at ${key}`));
    return true;
  }
  if (f.kind === "status") {
    const status = f.status ?? 503;
    if (status === 429) res.setHeader("Retry-After", "0");
    res.status(status).json(operationOutcome("transient", `simulated ${status} at ${key}`));
    return true;
  }
  return false;
}

export function logAccess(db: Db, table: "payer_access_log" | "hie_access_log") {
  return (req: Request, res: Response, next: NextFunction) => {
    res.on("finish", () => {
      try {
        db.prepare(`INSERT INTO ${table} (at, method, path, client, status) VALUES (?,?,?,?,?)`).run(
          nowIso(db), req.method, req.baseUrl + req.path, clientOf(req)?.clientId ?? "anonymous", res.statusCode,
        );
      } catch {
        /* database may be closed during test teardown */
      }
    });
    next();
  };
}
