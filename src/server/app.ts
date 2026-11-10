/**
 * Composition root: mounts the four simulators and the EvidenceBridge API on
 * one Express app. Adapters still reach the simulators over real HTTP, so the
 * orchestrator code path is identical to one that calls remote systems.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError } from "zod";
import { bindClock, clockOf, type Db } from "../persistence/db";
import { reviewDue } from "../domain/reviewDue";
import { sourceHistory } from "../persistence/sourceHistory";
import { CHAIN_ALGORITHM, verifyChain } from "../persistence/auditChain";
import { evidenceChecks } from "../orchestrator/evidenceChecks";
import { buildEvidencePackage, packageFilename } from "../orchestrator/evidencePackage";
import { createAccessGate } from "./accessGate";
import { canonicalJson } from "../domain/integrity";
import type { Clock } from "../domain/clock";
import { advanceScenarioClock, ScenarioClock, type ClockState } from "../persistence/scenarioClock";
import type { Config } from "./config";
import { createEhrRouter } from "../simulators/ehrSimulator";
import { createPayerRouter } from "../simulators/payerSimulator";
import { createHieRouter } from "../simulators/hieSimulator";
import { createPolicyRouter } from "../simulators/policySimulator";
import { FaultConfigSchema, BEHAVIOR_FAULTS, DEMO_CLINICIAN_TOKEN, EHR_WORKFLOW_TOKEN, FAULT_POINTS, ORCHESTRATOR_TOKEN, SIM_ADMIN_TOKEN, listFaults, setFault, type FaultKey } from "../simulators/shared";
import { MockEhrAdapter } from "../adapters/MockEhrAdapter";
import { MockProviderAccessAdapter } from "../adapters/MockProviderAccessAdapter";
import { MockHieAdapter } from "../adapters/MockHieAdapter";
import { SyntheticPolicyAdapter } from "../adapters/SyntheticPolicyAdapter";
import { HttpClient, UpstreamError, type HttpCallRecord } from "../adapters/http";
import type { Adapters, DraftView } from "../adapters/ports";
import type { FhirTask } from "../domain/contracts";
import { MockSimulatorProbeAdapter } from "../adapters/MockSimulatorProbeAdapter";
import { FixtureEvidenceExtractor } from "../agents/FixtureEvidenceExtractor";
import { LlmEvidenceExtractor } from "../agents/LlmEvidenceExtractor";
import type { EvidenceExtractor } from "../agents/EvidenceExtractor";
import { emitAndProcess, executeStagedTask, type OrchestratorDeps } from "../orchestrator/processPriorAuthDraft";
import { ToolAuthorizationError, type ToolActor } from "../tools/createEvidenceReviewTask";
import { getRun, latestRunForDraft, listRuns, listRunSummariesForDraft } from "../persistence/runStore";
import { listAppAudit, listEhrAudit } from "../persistence/auditStore";
import { activeScenarioId, listScenarios, loadScenario } from "./scenarios";
import { createDataRouter } from "./dataRoutes";
import { log } from "./logger";
import type { Run } from "../orchestrator/runTypes";

export type AppHandle = {
  app: express.Express;
  setBaseUrl: (url: string) => void;
  deps: () => OrchestratorDeps;
};

const ROLES = ["pa-specialist", "viewer", "sim-admin"] as const;
type Role = (typeof ROLES)[number];

/** Demo identity switch — NOT production authentication. */
function actorOf(req: Request): ToolActor {
  const role = (req.header("x-demo-role") ?? "pa-specialist") as Role;
  const safeRole: Role = ROLES.includes(role) ? role : "viewer";
  return { userId: `demo-${safeRole}`, role: safeRole };
}
function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const a = actorOf(req);
    if (!roles.includes(a.role)) return void res.status(403).json({ error: `role ${a.role} is not permitted to perform this action (demo identity)` });
    res.locals.actor = a;
    next();
  };
}

export function createApp(opts: { db: Db; config: Config; extractor?: EvidenceExtractor; clock?: Clock }): AppHandle {
  const { db, config } = opts;
  // CH-0B: every business timestamp for this database comes from one clock.
  const scenarioClock = new ScenarioClock(db);
  bindClock(db, opts.clock ?? scenarioClock);
  const clockState = (): ClockState =>
    opts.clock ? { mode: "scenario", now: opts.clock.now().toISOString(), anchor: null, offsetMs: 0 } : scenarioClock.state();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.gate.trustProxy);
  app.use(express.json({ limit: "256kb" }));

  // CH-22: lightweight readiness check. Read-only, no details, never behind the access gate.
  app.get("/healthz", (_req, res) => {
    try {
      db.prepare("SELECT 1").get();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // CH-20: visitor access gate. Mounted before the simulators, the API and the static UI.
  const gate = createAccessGate(config.gate);
  app.use(gate.middleware);

  // ---- Simulators (each owns its own table prefix) ----
  app.use("/mock-ehr", createEhrRouter(db));
  app.use("/mock-payer", createPayerRouter(db));
  app.use("/mock-hie", createHieRouter(db));
  app.use("/mock-policy", createPolicyRouter(db));

  let baseUrl = `http://127.0.0.1:${config.port}`;
  const httpOpts = () => ({ defaultHeaders: gate.internalHeaders, token: ORCHESTRATOR_TOKEN, timeoutMs: config.httpTimeoutMs, maxRetries: config.httpMaxRetries, baseBackoffMs: config.httpBaseBackoffMs });

  let extractor: EvidenceExtractor | null = opts.extractor ?? null;
  let extractorError: string | null = null;
  if (!extractor) {
    try {
      extractor = config.extractor === "llm" ? new LlmEvidenceExtractor({ apiKey: config.anthropicApiKey, model: config.llmModel }) : new FixtureEvidenceExtractor();
    } catch (err) {
      extractorError = (err as Error).message;
    }
  }

  const makeAdapters = (onCall: (rec: HttpCallRecord) => void): Adapters => {
    const ehr = new MockEhrAdapter({ ...httpOpts(), baseUrl: `${baseUrl}/mock-ehr` }, EHR_WORKFLOW_TOKEN);
    const payer = new MockProviderAccessAdapter({ ...httpOpts(), baseUrl: `${baseUrl}/mock-payer` });
    const hie = new MockHieAdapter({ ...httpOpts(), baseUrl: `${baseUrl}/mock-hie` });
    const policy = new SyntheticPolicyAdapter({ ...httpOpts(), baseUrl: `${baseUrl}/mock-policy` });
    const probe = new MockSimulatorProbeAdapter({ ...httpOpts(), baseUrl: `${baseUrl}/mock-payer` });
    for (const a of [ehr, payer, hie, policy, probe]) a.onCall = onCall;
    return { ehr, payer, hie, policy, probe };
  };
  const deps = (): OrchestratorDeps => {
    if (config.errors.length || !extractor) {
      throw new ConfigBlockedError([...config.errors, ...(extractorError ? [extractorError] : [])]);
    }
    return {
      db,
      makeAdapters,
      extractor,
      requestingProviderOrgId: config.requestingProviderOrgId,
      maxRunAgeMs: config.maxRunAgeHours * 3600_000,
    };
  };
  /** Read-only EHR view for the workspace screen, through the EHR port (V3 CH-1). */
  const adminEhr = () => new MockEhrAdapter({ defaultHeaders: gate.internalHeaders, baseUrl: `${baseUrl}/mock-ehr`, token: SIM_ADMIN_TOKEN, timeoutMs: 3000, maxRetries: 0, baseBackoffMs: 50 }, SIM_ADMIN_TOKEN);

  const api = express.Router();

  api.get("/health", (_req, res) => {
    res.json({
      ok: config.errors.length === 0 && !extractorError,
      mode: config.mode,
      extractor: extractor?.kind ?? null,
      configErrors: [...config.errors, ...(extractorError ? [extractorError] : [])],
      synthetic: true,
      accessGate: config.gate.enabled,
      // CH-21: only behind the gate, so it reaches a browser only after verified entry.
      analytics: config.gate.enabled ? config.analytics : null,
    });
  });

  api.get("/scenarios", (_req, res) => {
    res.json({ active: activeScenarioId(db), scenarios: listScenarios() });
  });

  api.post("/scenarios/:id/load", requireRole("pa-specialist", "sim-admin"), (req, res) => {
    const sc = loadScenario(db, String(req.params.id));
    log("info", "scenario loaded", { scenario: sc.id });
    res.json({ active: sc.id, scenario: sc });
  });

  api.get("/workspace", async (req, res) => {
    const scId = activeScenarioId(db);
    const sc = listScenarios().find((s) => s.id === scId) ?? null;
    const draftId = String(req.query.draftId ?? sc?.draftId ?? "PA-DRAFT-99412");
    let draft: DraftView | null = null;
    let tasks: FhirTask[] = [];
    try {
      const ehr = adminEhr();
      draft = await ehr.getDraft(draftId);
      tasks = await ehr.listTasksForDraft(draftId);
    } catch (err) {
      if (!(err instanceof UpstreamError && err.status === 404)) throw err;
    }
    const run = latestRunForDraft(db, draftId);
    // CH-5: due state is derived on read from each Task's own due time and the scenario clock. Read-only.
    const now = clockOf(db).now();
    // CH-8: this system's own history with the clinic the claim leads point to (current draft excluded).
    const sourceOrgId = run?.claims?.providerOrgId ?? null;
    const history = sourceOrgId ? sourceHistory(db, { sourceOrgId, now, excludeDraftId: draftId }) : null;
    const taskDue = tasks.map((t) => ({ taskId: t.id, owner: t.owner.reference, ...reviewDue(t.restriction.period.end, now) }));
    res.json({ scenario: sc, draftId, draft, tasks, taskDue, sourceHistory: history, runHistory: listRunSummariesForDraft(db, draftId), evidenceChecks: run ? evidenceChecks(run) : [], limits: { maxRunAgeHours: config.maxRunAgeHours }, run: run ? viewRun(run, actorOf(req)) : null, faults: listFaults(db), clock: clockState() });
  });

  api.post("/drafts/:id/check", requireRole("pa-specialist"), async (req, res) => {
    const run = await emitAndProcess(deps(), String(req.params.id));
    res.json({ run: viewRun(run, res.locals.actor as ToolActor) });
  });

  api.post("/runs/:id/stage", requireRole("pa-specialist", "viewer", "sim-admin"), async (req, res) => {
    // Role is enforced inside the tool (defence in depth): a viewer gets a 403 from the tool guard.
    const run = await executeStagedTask(deps(), String(req.params.id), res.locals.actor as ToolActor);
    res.json({ run: viewRun(run, res.locals.actor as ToolActor) });
  });

  api.post("/drafts/:id/simulate-edit", requireRole("pa-specialist", "sim-admin"), async (req, res) => {
    const draft = await adminEhr().getDraft(String(req.params.id));
    // The edit itself is a demo clinician action on the simulator, not a domain read, so it stays a direct demo call.
    const clinician = new HttpClient({ defaultHeaders: gate.internalHeaders, system: "mock-ehr", baseUrl: `${baseUrl}/mock-ehr`, token: DEMO_CLINICIAN_TOKEN, timeoutMs: 3000, maxRetries: 0, baseBackoffMs: 50 });
    const r = await clinician.request("PATCH", `prior-auth-drafts/${String(req.params.id)}`, { body: { expectedVersion: draft.version, note: "demo: another user edited the draft" }, retry: false });
    res.json({ draft: r.body });
  });

  api.get("/clock", (_req, res) => res.json(clockState()));
  // Demo control: move scenario time forward (never backward). Not available with an injected test clock.
  api.post("/clock/advance", requireRole("pa-specialist", "sim-admin"), (req, res) => {
    const hours = Number(req.body?.hours);
    if (opts.clock) return void res.status(409).json({ error: "an injected clock is in use; scenario time cannot be moved" });
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) return void res.status(400).json({ error: "hours must be a positive number up to 720" });
    advanceScenarioClock(db, hours * 3600_000);
    res.json(clockState());
  });

  api.get("/runs", (_req, res) => res.json(listRuns(db)));
  // CH-18: audit evidence package. Read-only. Demo roles with audit access only; fails closed like execution routes.
  api.get("/runs/:id/evidence-package", requireRole("pa-specialist", "sim-admin"), (req, res) => {
    if (config.errors.length) return void res.status(503).json({ error: "configuration blocks execution (fail closed)", configErrors: config.errors });
    const run = getRun(db, String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run not found" });
    const pkg = buildEvidencePackage(db, run, { role: (res.locals.actor as ToolActor).role });
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${packageFilename(run.runId)}"`);
    res.setHeader("x-content-type-options", "nosniff");
    res.send(canonicalJson(pkg));
  });

  api.get("/runs/:id", (req, res) => {
    const run = getRun(db, String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run not found" });
    res.json({ run: viewRun(run, actorOf(req)) });
  });
  api.get("/audit", (req, res) => {
    res.json({ app: listAppAudit(db, req.query.runId ? String(req.query.runId) : undefined), ehr: listEhrAudit(db, 100) });
  });

  // CH-17: verify the audit hash chains. Read-only.
  api.get("/audit/verify", (_req, res) => {
    res.json({ algorithm: CHAIN_ALGORITHM, tables: [verifyChain(db, "ehr_audit"), verifyChain(db, "app_audit")], limits: "Tamper-evident against simple edits only. Not signed, not anchored outside this database, not a certification." });
  });

  api.get("/faults", (_req, res) => res.json({ points: FAULT_POINTS, behaviors: BEHAVIOR_FAULTS, active: listFaults(db) }));
  api.put("/faults/:key", requireRole("sim-admin", "pa-specialist"), (req, res) => {
    const key = String(req.params.key);
    if (!isFaultKey(key)) return void res.status(400).json({ error: "unknown fault key" });
    const cfg = FaultConfigSchema.safeParse(req.body);
    if (!cfg.success) return void res.status(400).json({ error: "invalid fault config", issues: cfg.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    setFault(db, key, cfg.data);
    res.json({ active: listFaults(db) });
  });
  api.delete("/faults/:key", requireRole("sim-admin", "pa-specialist"), (req, res) => {
    const key = String(req.params.key);
    if (!isFaultKey(key)) return void res.status(400).json({ error: "unknown fault key" });
    setFault(db, key, null);
    res.json({ active: listFaults(db) });
  });

  api.use("/data", createDataRouter(db, { requireRole }));

  app.use("/api", api);

  // ---- Production static UI ----
  const dist = resolve("dist");
  if (process.env.NODE_ENV === "production" && existsSync(dist)) {
    app.use(express.static(dist));
    app.get("/{*rest}", (req, res, next) => (req.path.startsWith("/api") || req.path.startsWith("/mock-") ? next() : res.sendFile(resolve(dist, "index.html"))));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ConfigBlockedError) return void res.status(503).json({ error: "configuration blocks execution (fail closed)", configErrors: err.errors });
    if (err instanceof ToolAuthorizationError) return void res.status(403).json({ error: err.message });
    if (err instanceof ZodError) return void res.status(400).json({ error: "validation failed", issues: err.issues });
    if (err instanceof UpstreamError) return void res.status(502).json({ error: err.message, upstreamStatus: err.status });
    const status = httpStatusOf(err);
    if (typeof status === "number" && status >= 400 && status < 500) {
      return void res.status(status).json({ error: status === 413 ? "upload exceeds the 2 MB limit" : (err as Error).message });
    }
    log("error", "unhandled error", { message: (err as Error).message });
    res.status(500).json({ error: (err as Error).message });
  });

  return {
    app,
    setBaseUrl: (url) => {
      baseUrl = url;
    },
    deps,
  };
}

class ConfigBlockedError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join(" "));
  }
}

/** Shapes a run for the UI. Document pages are only returned to roles allowed to review evidence. */
function viewRun(run: Run, actor: ToolActor): Run {
  if (actor.role === "pa-specialist") return run;
  return { ...run, documentPages: undefined };
}

function isFaultKey(key: string): key is FaultKey {
  return (FAULT_POINTS as readonly string[]).includes(key) || (BEHAVIOR_FAULTS as readonly string[]).includes(key);
}

/** Reads an HTTP status from an Express/body-parser error without casting. */
function httpStatusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const s = "status" in err ? err.status : "statusCode" in err ? err.statusCode : undefined;
  return typeof s === "number" ? s : undefined;
}
