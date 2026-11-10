/**
 * Orchestrator for the EvidenceBridge vertical slice.
 *
 * TRIGGER → AUTHORIZED CONTEXT → EXTRACTION (bounded agent) → INDEPENDENT
 * DETERMINISTIC POLICY → HUMAN CONFIRMATION → TOOL → PERSIST → READ-BACK → AUDIT
 *
 * Phase 1 (processPriorAuthDraft): steps 1–10 of spec §8, ending in a decision.
 * Phase 2 (executeStagedTask): steps 11–13, triggered by the PA specialist's
 * "Stage evidence review task" action. The model never calls tools.
 */
import { randomUUID } from "node:crypto";
import {
  MISSING_REQUIREMENT_CODE,
  PriorAuthDraftCreatedSchema,
  REVIEWER_QUEUE,
  type CreateEvidenceReviewTaskInput,
  type EvidencePolicyInput,
  type PriorAuthDraftCreated,
} from "../domain/contracts";
import { evaluateEvidencePolicy } from "../domain/evidencePolicy";
import { canonicalJson, sha256Hex, splitPages, validateExtractionOutput, verifyCitations } from "../domain/integrity";
import { computePatientMatch } from "../domain/patientMatch";
import type { Adapters, ClaimLead } from "../adapters/ports";
import { UpstreamError, type HttpCallRecord } from "../adapters/http";
import { conflictCodeOf } from "../adapters/wireSchemas";
import type { EvidenceExtractor } from "../agents/EvidenceExtractor";
import { createEvidenceReviewTask, ToolAuthorizationError, verifyTaskReadback, type ToolActor } from "../tools/createEvidenceReviewTask";
import type { Db } from "../persistence/db";
import { clockOf, nowIso } from "../persistence/db";
import { saveRun, getRun } from "../persistence/runStore";
import { appendAppAudit } from "../persistence/auditStore";
import { log } from "../server/logger";
import type { PreWriteCheck, Run, TraceStep } from "./runTypes";

export type OrchestratorDeps = {
  db: Db;
  /** Builds adapters whose HTTP calls are reported to the given hook (per-run isolation). */
  makeAdapters: (onCall: (rec: HttpCallRecord) => void) => Adapters;
  extractor: EvidenceExtractor;
  requestingProviderOrgId: string;
  /** CH-0A: maximum age of an evaluated run that may still be staged. */
  maxRunAgeMs: number;
  /** Current time for business checks. Defaults to the clock bound to `db` (scenario clock in the app). */
  now?: () => Date;
};

class Tracer {
  private buffer: HttpCallRecord[] = [];
  constructor(private readonly run: Run, private readonly db: Db) {}
  readonly onCall = (rec: HttpCallRecord) => this.buffer.push(rec);
  async step<T>(step: string, actor: TraceStep["actor"], fn: () => Promise<T> | T, summarize: (v: T) => string, data?: (v: T) => Record<string, unknown>): Promise<T> {
    const started = Date.now();
    this.buffer = [];
    try {
      const v = await fn();
      this.push({ step, actor, ok: true, summary: summarize(v), durationMs: Date.now() - started, calls: this.buffer, ...(data ? { data: data(v) } : {}) });
      return v;
    } catch (err) {
      this.push({ step, actor, ok: false, summary: (err as Error).message, durationMs: Date.now() - started, calls: this.buffer });
      throw err;
    }
  }
  note(step: string, actor: TraceStep["actor"], ok: boolean, summary: string, data?: Record<string, unknown>) {
    this.push({ step, actor, ok, summary, durationMs: 0, calls: [], ...(data ? { data } : {}) });
  }
  private push(s: Omit<TraceStep, "seq" | "at">) {
    this.run.trace.push({ seq: this.run.trace.length + 1, at: nowIso(this.db), ...s });
  }
}

function blankRun(db: Db, event: PriorAuthDraftCreated, deliveryCount: number): Run {
  const at = nowIso(db);
  return {
    runId: `RUN-${randomUUID().slice(0, 8).toUpperCase()}`,
    event,
    deliveryCount,
    status: "EVALUATING",
    createdAt: at,
    updatedAt: at,
    context: null,
    access: null,
    claims: null,
    document: null,
    patientMatch: null,
    extraction: null,
    lookback: null,
    policyInput: null,
    policyResult: null,
    outcomeState: null,
    stagedToolInput: null,
    execution: { confirmedBy: null, toolCalls: 0, result: null, error: null, readback: null, payerWriteRequests: null, stateChange: null },
    trace: [],
    error: null,
  };
}

function monthsBefore(iso: string, months: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

function persist(db: Db, run: Run): Run {
  run.updatedAt = nowIso(db);
  saveRun(db, run);
  return run;
}

/** Ask the EHR to emit PriorAuthDraftCreated from its current state, then process it. */
export async function emitAndProcess(deps: OrchestratorDeps, draftId: string): Promise<Run> {
  const calls: HttpCallRecord[] = [];
  const { ehr } = deps.makeAdapters((r) => calls.push(r));
  const { event, deliveryCount } = await ehr.emitDraftCreated(draftId);
  return processPriorAuthDraft(deps, event, deliveryCount, calls);
}

export async function processPriorAuthDraft(
  deps: OrchestratorDeps,
  rawEvent: unknown,
  deliveryCount = 1,
  emitCalls: HttpCallRecord[] = [],
): Promise<Run> {
  const event = PriorAuthDraftCreatedSchema.parse(rawEvent);
  const run = blankRun(deps.db, event, deliveryCount);
  const t = new Tracer(run, deps.db);
  const a = deps.makeAdapters(t.onCall);
  run.trace.push({
    seq: 1, at: nowIso(deps.db), step: "EVENT_RECEIVED", actor: "event", ok: true,
    summary: `PriorAuthDraftCreated ${event.eventId} (delivery #${deliveryCount})`, durationMs: 0, calls: emitCalls,
    data: { event },
  });
  appendAppAudit(deps.db, run.runId, "EVENT_RECEIVED", { eventId: event.eventId, draftId: event.draftId, deliveryCount });
  log("info", "run started", { runId: run.runId, eventId: event.eventId });

  const policyInput: EvidencePolicyInput = {
    patientMatch: "NONE", providerAttributed: false, patientOptedOut: false, policyVersionMatches: false, draftVersionMatches: false,
    claimLeadCount: 0, clinicalDocumentFound: false, documentHashVerified: false, citationsValid: false, evidenceWithinLookback: false,
    agentAbstained: false, sourceUnavailable: false, otherCandidateDocumentCount: 0,
  };

  const decide = () => {
    run.policyInput = { ...policyInput };
    const result = evaluateEvidencePolicy(policyInput);
    run.policyResult = result;
    run.outcomeState = result.outcomeState;
    t.note("POLICY_DECISION", "policy", true, `${result.decision} (${result.ruleId})`, { input: policyInput, result });
    appendAppAudit(deps.db, run.runId, "DECISION", { decision: result.decision, ruleId: result.ruleId, outcomeState: result.outcomeState });
    return result;
  };

  try {
    // ---- 2. Load versioned context -------------------------------------------------
    const ctx = await t.step(
      "LOAD_CONTEXT", "orchestrator",
      async () => {
        const draft = await a.ehr.getDraft(event.draftId);
        const [sr, cov, patient, localDocs, policy] = await Promise.all([
          a.ehr.getServiceRequest(event.serviceRequestId),
          a.ehr.getCoverage(event.coverageId),
          a.ehr.getPatient(event.patientId),
          a.ehr.listLocalDocuments(event.patientId),
          a.policy.getPolicy(draft.policyVersion),
        ]);
        return { draft, sr, cov, patient, localDocs, policy };
      },
      (c) => `Draft ${c.draft.id} v${c.draft.version} (${c.draft.businessStatus}); policy ${c.policy.policyVersion} [${c.policy.status}]`,
    );
    const requirement = ctx.policy.requirements.find((r) => r.code === MISSING_REQUIREMENT_CODE);
    if (!requirement) throw new Error(`policy ${ctx.policy.policyVersion} has no ${MISSING_REQUIREMENT_CODE} requirement`);
    if (ctx.draft.patientId !== event.patientId || ctx.sr.patientId !== event.patientId || ctx.cov.patientId !== event.patientId) {
      throw new Error("event, draft, service request and coverage refer to different patients");
    }
    policyInput.draftVersionMatches = ctx.draft.version === event.draftVersion;
    policyInput.policyVersionMatches = ctx.policy.policyVersion === ctx.draft.policyVersion && ctx.policy.status === "active";

    // ---- 3. Deterministic gap check ------------------------------------------------
    const windowStart = monthsBefore(event.occurredAt, requirement.lookbackMonths);
    const localMatch = ctx.localDocs.find((d) => requirement.localDocumentTypes.includes(d.type) && d.date >= windowStart);
    run.context = {
      draft: ctx.draft,
      serviceRequestDescription: ctx.sr.description,
      coveragePlan: ctx.cov.planName,
      patientAgeBand: ctx.patient.ageBand,
      policy: {
        policyVersion: ctx.policy.policyVersion, status: ctx.policy.status, label: ctx.policy.label, lookbackMonths: requirement.lookbackMonths,
        effectiveFrom: ctx.policy.effectiveFrom, effectiveTo: ctx.policy.effectiveTo, requirementCount: ctx.policy.requirements.length,
      },
      missingRequirement: { code: requirement.code, description: requirement.description, localStatus: localMatch ? "PRESENT" : "MISSING" },
      localDocuments: ctx.localDocs,
    };
    t.note("GAP_CHECK", "orchestrator", true,
      localMatch ? `${requirement.code} present locally (${localMatch.id}); no external search` : `${requirement.code} missing from local chart`,
      { localDocumentTypes: ctx.localDocs.map((d) => d.type), windowStart });
    if (localMatch) {
      run.status = "NO_GAP";
      appendAppAudit(deps.db, run.runId, "NO_ACTION", { reason: "requirement present locally" });
      return persist(deps.db, run);
    }

    if (!policyInput.draftVersionMatches || !policyInput.policyVersionMatches) {
      // Stale event or superseded policy: stop before any external retrieval.
      decide();
      run.status = "NO_ACTION";
      appendAppAudit(deps.db, run.runId, "NO_ACTION", { reason: run.policyResult?.ruleId });
      return persist(deps.db, run);
    }

    // ---- 4. Access gate before any external retrieval ------------------------------
    try {
      run.access = await t.step(
        "PROVIDER_ACCESS_AUTHORIZATION", "orchestrator",
        () => a.payer.checkAuthorization(event.patientId, deps.requestingProviderOrgId, event.occurredAt.slice(0, 10)),
        (acc) => `${acc.decision}: attributed=${acc.attributed}, optedOut=${acc.optedOut}`,
      );
    } catch (err) {
      if (isSourceFailure(err)) return finishSourceUnavailable(deps, run, t, policyInput, decide, err);
      throw err;
    }
    appendAppAudit(deps.db, run.runId, "ACCESS_DECISION", { decision: run.access.decision, reasons: run.access.reasons });
    policyInput.providerAttributed = run.access.attributed;
    policyInput.patientOptedOut = run.access.optedOut;
    if (run.access.decision !== "PERMIT") {
      t.note("EXTERNAL_RETRIEVAL_SKIPPED", "orchestrator", true, "Access not permitted — no claims or HIE documents were requested.");
      decide();
      run.status = "NO_ACTION";
      appendAppAudit(deps.db, run.runId, "NO_ACTION", { reason: "ACCESS_NOT_PERMITTED" });
      return persist(deps.db, run);
    }

    // ---- 5–6. Claims as leads only -------------------------------------------------
    let leads: ClaimLead[];
    try {
      leads = await t.step(
        "CLAIM_LEADS", "orchestrator",
        () => a.payer.listClaims(event.patientId, deps.requestingProviderOrgId, event.occurredAt.slice(0, 10)),
        (l) => `${l.length} adjudicated claim line(s) returned — leads only, not clinical proof`,
      );
    } catch (err) {
      if (isSourceFailure(err)) return finishSourceUnavailable(deps, run, t, policyInput, decide, err);
      throw err;
    }
    const inWindow = leads.filter((l) => l.serviceDate >= windowStart && l.serviceDate <= event.occurredAt.slice(0, 10));
    const byProvider = new Map<string, ClaimLead[]>();
    for (const l of inWindow) byProvider.set(l.providerOrgId, [...(byProvider.get(l.providerOrgId) ?? []), l]);
    const top = [...byProvider.values()].sort((x, y) => y.length - x.length)[0] ?? [];
    const dates = top.map((l) => l.serviceDate).sort();
    run.claims = {
      leads: top,
      leadCount: top.length,
      providerOrgId: top[0]?.providerOrgId ?? null,
      providerName: top[0]?.providerName ?? null,
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      codes: [...new Set(top.map((l) => l.code))],
    };
    policyInput.claimLeadCount = top.length;

    // ---- 7. Locate one external document using lead provider + dates --------------
    if (top.length > 0) {
      let docs;
      try {
        docs = await t.step(
          "HIE_DOCUMENT_SEARCH", "orchestrator",
          () => a.hie.searchDocuments({
            patientId: event.patientId,
            authorOrgId: run.claims!.providerOrgId ?? undefined,
            type: requirement.externalDocumentTypes[0],
            periodFrom: run.claims!.firstDate ?? undefined,
            periodTo: run.claims!.lastDate ?? undefined,
          }),
          (d) => `${d.length} candidate document(s) from ${run.claims!.providerName}`,
        );
      } catch (err) {
        if (isSourceFailure(err)) return finishSourceUnavailable(deps, run, t, policyInput, decide, err);
        throw err;
      }
      const doc = [...docs].sort((x, y) => (x.date < y.date ? 1 : -1))[0];
      // CH-6: every candidate is recorded. Any extra candidate goes to a person (policy R5_MULTIPLE_CANDIDATES).
      run.candidates = docs.map((d) => ({
        id: d.id, date: d.date, title: d.title, periodStart: d.periodStart, periodEnd: d.periodEnd, declaredSha256: d.declaredSha256,
        selected: d.id === doc?.id,
        sameContentAsSelected: !!doc && d.id !== doc.id && !!d.declaredSha256 && d.declaredSha256 === doc.declaredSha256,
      }));
      policyInput.otherCandidateDocumentCount = Math.max(0, docs.length - 1);
      if (docs.length > 1) {
        t.note("MULTIPLE_CANDIDATES", "verification", false, `${docs.length} candidate documents from the same source and period; the newest is read, a person must choose`, { ids: docs.map((d) => d.id) });
        appendAppAudit(deps.db, run.runId, "POSSIBLE_DUPLICATE_DOCUMENT", { ids: docs.map((d) => d.id) });
      }
      if (doc) {
        let payload: string;
        try {
          payload = await t.step("HIE_DOCUMENT_RETRIEVE", "orchestrator", () => a.hie.getBinary(doc.binaryRef), (p) => `${doc.binaryRef} retrieved (${p.length} chars; body not logged)`);
        } catch (err) {
          if (isSourceFailure(err)) return finishSourceUnavailable(deps, run, t, policyInput, decide, err);
          throw err;
        }
        const computed = sha256Hex(payload);
        const pages = splitPages(payload);
        run.document = { ...doc, computedSha256: computed, hashVerified: !!doc.declaredSha256 && computed === doc.declaredSha256, pageCount: pages.length };
        run.documentPages = pages;
        policyInput.clinicalDocumentFound = true;
        policyInput.documentHashVerified = run.document.hashVerified;
        t.note("DOCUMENT_HASH", "verification", run.document.hashVerified,
          run.document.hashVerified ? "SHA-256 of payload matches the DocumentReference" : "SHA-256 mismatch — payload differs from the indexed document",
          { declared: doc.declaredSha256, computed });

        // ---- patient correlation (deterministic) ----
        run.patientMatch = computePatientMatch({
          expectedPatientId: event.patientId,
          expectedAgeBand: ctx.patient.ageBand,
          documentSubjectRef: doc.patientRef,
          mpiMatchConfidence: doc.mpiMatchConfidence,
          documentText: payload,
        });
        policyInput.patientMatch = run.patientMatch.match;
        t.note("PATIENT_MATCH", "verification", run.patientMatch.match === "EXACT", `${run.patientMatch.match}: ${run.patientMatch.reasons.join(" ")}`);

        // ---- 8. Bounded extraction (skipped when it would process another patient's or tampered data) ----
        if (run.patientMatch.match === "NONE" || !run.document.hashVerified) {
          const skippedReason = run.patientMatch.match === "NONE" ? "patient mismatch — document not processed (minimum necessary)" : "hash mismatch — tampered payload not processed";
          run.extraction = { extractor: deps.extractor.kind, output: null, validationIssues: [], citationChecks: [], extractionHash: null, skippedReason };
          t.note("EVIDENCE_EXTRACTION", "agent", false, `skipped: ${skippedReason}`);
        } else {
          let raw: unknown;
          let extractorError: string | null = null;
          try {
            raw = await t.step("EVIDENCE_EXTRACTION", "agent",
              () => deps.extractor.extract({ documentId: doc.id, pages, expectedPatientId: event.patientId, requirementCode: MISSING_REQUIREMENT_CODE }),
              () => `${deps.extractor.kind} extractor returned output (validated next)`);
          } catch (err) {
            extractorError = (err as Error).message;
          }
          // ---- 9. Deterministic validation of agent output ----
          const v = extractorError ? { ok: false as const, extraction: null, issues: [`extractor error: ${extractorError}`] } : validateExtractionOutput(raw);
          const facts = v.extraction?.facts ?? [];
          const cites = verifyCitations(facts, pages);
          const extractionHash = v.ok ? sha256Hex(canonicalJson(v.extraction)) : null;
          run.extraction = {
            extractor: deps.extractor.kind,
            output: v.ok ? v.extraction : null,
            validationIssues: v.issues,
            citationChecks: cites.checks,
            extractionHash,
          };
          const abstained = !v.ok || v.extraction!.abstain;
          policyInput.agentAbstained = abstained;
          policyInput.citationsValid = v.ok && cites.allValid && (v.extraction!.abstain || facts.length > 0);
          t.note("EXTRACTION_VALIDATION", "verification", v.ok && policyInput.citationsValid,
            v.ok
              ? `schema valid; ${facts.length} fact(s); citations ${cites.allValid ? "all exact" : "INVALID"}; abstain=${v.extraction!.abstain}`
              : `agent output rejected: ${v.issues.join("; ")}`,
            { issues: v.issues, citationChecks: cites.checks, ambiguity: v.extraction?.ambiguity ?? [] });

          // ---- lookback ----
          const end = v.ok ? v.extraction!.facts.find((f) => f.field === "therapy_end_date")?.normalizedValue : null;
          const evidenceDate = typeof end === "string" ? end : doc.periodEnd;
          const within = evidenceDate >= windowStart && evidenceDate <= event.occurredAt.slice(0, 10);
          run.lookback = { windowStart, evidenceDate, within };
          policyInput.evidenceWithinLookback = within;
        }
      }
    } else {
      t.note("HIE_DOCUMENT_SEARCH", "orchestrator", true, "No claim leads in the lookback window; no external source to locate.");
    }

    // ---- 10. Decision ----------------------------------------------------------------
    const result = decide();
    if (result.createsTask && run.document && run.extraction?.extractionHash) {
      const dueAt = new Date(new Date(event.occurredAt).getTime() + 2 * 24 * 3600 * 1000).toISOString();
      run.stagedToolInput = {
        idempotencyKey: `evb-${sha256Hex(`${event.eventId}|${event.draftId}|${event.draftVersion}|${MISSING_REQUIREMENT_CODE}`).slice(0, 40)}`,
        expectedDraftVersion: event.draftVersion,
        draftId: event.draftId,
        serviceRequestId: event.serviceRequestId,
        syntheticPatientId: event.patientId,
        missingRequirementCode: MISSING_REQUIREMENT_CODE,
        policyVersion: ctx.draft.policyVersion,
        claimLeadIds: [...new Set(run.claims!.leads.map((l) => l.id))],
        evidenceDocumentId: run.document.id,
        evidenceDocumentHash: run.document.computedSha256,
        extractionHash: run.extraction.extractionHash,
        reviewerQueue: REVIEWER_QUEUE,
        dueAt,
      };
      run.status = "AWAITING_CONFIRMATION";
      t.note("TOOL_STAGED", "orchestrator", true, "createEvidenceReviewTask staged; waiting for PA specialist confirmation");
    } else {
      run.status = "NO_ACTION";
      appendAppAudit(deps.db, run.runId, "NO_ACTION", { reason: result.ruleId });
    }
    return persist(deps.db, run);
  } catch (err) {
    run.status = "FAILED";
    run.error = (err as Error).message;
    t.note("RUN_FAILED", "orchestrator", false, run.error);
    appendAppAudit(deps.db, run.runId, "RUN_FAILED", { message: run.error });
    log("error", "run failed", { runId: run.runId, message: run.error });
    return persist(deps.db, run);
  }
}

function finishSourceUnavailable(
  deps: OrchestratorDeps, run: Run, t: Tracer, policyInput: EvidencePolicyInput, decide: () => unknown, err: UpstreamError,
): Run {
  policyInput.sourceUnavailable = true;
  t.note("SOURCE_UNAVAILABLE", "orchestrator", false, `${err.system}: ${err.message} after ${err.attempts} attempt(s)`);
  decide();
  run.status = "NO_ACTION";
  appendAppAudit(deps.db, run.runId, "NO_ACTION", { reason: "SOURCE_UNAVAILABLE", system: err.system });
  return persist(deps.db, run);
}

// =====================================================================================
// Phase 2 — human-confirmed tool execution with read-after-write verification
// =====================================================================================
export async function executeStagedTask(deps: OrchestratorDeps, runId: string, actor: ToolActor): Promise<Run> {
  const run = getRun(deps.db, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status !== "AWAITING_CONFIRMATION" && run.status !== "FAILED_RETRYABLE") {
    throw new ToolAuthorizationError(`run ${runId} is ${run.status}; nothing to stage`);
  }
  if (!run.stagedToolInput || !run.policyResult) throw new Error("run has no staged tool input");
  const t = new Tracer(run, deps.db);
  const a = deps.makeAdapters(t.onCall);
  const startedAt = nowIso(deps.db);
  const draftStatusBefore = run.context?.draft.businessStatus ?? "DRAFT_INCOMPLETE";

  t.note("USER_CONFIRMATION", "user", true, `${actor.userId} (${actor.role}) confirmed staging`);
  appendAppAudit(deps.db, run.runId, "USER_CONFIRMATION", { userId: actor.userId, role: actor.role });
  run.execution.confirmedBy = actor.userId;
  run.status = "EXECUTING";
  persist(deps.db, run);

  const input: CreateEvidenceReviewTaskInput = run.stagedToolInput;

  // ---- CH-0A: re-check age and access immediately before the one write ----
  const refused = await preWriteRecheck(deps, run, t, a, input);
  if (refused) return refused;
  try {
    run.execution.toolCalls += 1;
    const result = await t.step(
      "TOOL_CALL createEvidenceReviewTask", "tool",
      () => createEvidenceReviewTask(a.ehr, input, { actor, policy: run.policyResult! }),
      (r) => `${r.taskId} ${r.duplicate ? "(idempotent replay — no new task)" : "created"}; draft v${r.draftVersion}`,
    );
    run.execution.result = result;
    appendAppAudit(deps.db, run.runId, "TOOL_RESULT", { taskId: result.taskId, duplicate: result.duplicate });
  } catch (err) {
    if (err instanceof ToolAuthorizationError) {
      run.status = run.status === "EXECUTING" ? "AWAITING_CONFIRMATION" : run.status;
      run.execution.toolCalls -= 1; // the EHR was never called
      run.execution.error = { kind: "authorization", status: 403, message: err.message };
      persist(deps.db, run);
      throw err;
    }
    if (err instanceof UpstreamError) {
      run.execution.error = { kind: err.kind, status: err.status, message: err.message };
      if (err.status === 409 && conflictCodeOf(err.body) === "VERSION_CONFLICT") {
        // Fail closed and reload context.
        const fresh = await t.step("RELOAD_CONTEXT", "orchestrator", () => a.ehr.getDraft(input.draftId),
          (d) => `Draft is now v${d.version} (${d.businessStatus}); event was for v${input.expectedDraftVersion}`);
        if (run.context) run.context.draft = fresh;
        run.outcomeState = "REEVALUATION_REQUIRED";
        run.status = "REEVALUATION_REQUIRED";
        appendAppAudit(deps.db, run.runId, "NO_ACTION", { reason: "VERSION_CONFLICT", currentVersion: fresh.version });
        return persist(deps.db, run);
      }
      if (err.retryable) {
        run.status = "FAILED_RETRYABLE";
        appendAppAudit(deps.db, run.runId, "TOOL_FAILED_RETRYABLE", { status: err.status, kind: err.kind });
        return persist(deps.db, run);
      }
      run.status = "FAILED";
      appendAppAudit(deps.db, run.runId, "TOOL_FAILED", { status: err.status, kind: err.kind });
      return persist(deps.db, run);
    }
    throw err;
  }

  // ---- 12. Independent read-after-write ----
  const result = run.execution.result!;
  try {
    const { task, draft, payerWrites } = await t.step(
      "READ_AFTER_WRITE", "verification",
      async () => ({
        task: await a.ehr.readTask(result.taskId),
        draft: await a.ehr.getDraft(input.draftId),
        // SIMULATED only: ask the payer simulator through its probe port. Absent elsewhere (not evaluated).
        payerWrites: a.probe ? await a.probe.countPayerWriteRequestsSince(startedAt) : null,
      }),
      ({ task, draft }) => `Task ${task.id} read back; draft ${draft.id} is ${draft.businessStatus} v${draft.version}`,
    );
    const checks = verifyTaskReadback(task, input, result);
    checks.push({ name: "draft status", expected: "EVIDENCE_REVIEW_PENDING", actual: draft.businessStatus, pass: draft.businessStatus === "EVIDENCE_REVIEW_PENDING" });
    checks.push({ name: "draft version unchanged", expected: String(input.expectedDraftVersion), actual: String(draft.version), pass: draft.version === input.expectedDraftVersion });
    run.execution.payerWriteRequests = payerWrites;
    if (payerWrites !== null) checks.push({ name: "payer write requests during run", expected: "0", actual: String(payerWrites), pass: payerWrites === 0 });
    const verified = checks.every((c) => c.pass);
    run.execution.readback = { task, checks, draftStatusAfter: draft.businessStatus, draftVersionAfter: draft.version, verified };
    t.note("READBACK_VERIFICATION", "verification", verified,
      verified ? `${checks.length}/${checks.length} readback checks passed` : `Readback mismatch: ${checks.filter((c) => !c.pass).map((c) => c.name).join(", ")}`,
      { checks });
    if (!verified) {
      run.status = "FAILED";
      run.error = "Readback did not match the requested Task. Execution is not reported as successful; reconcile manually.";
      appendAppAudit(deps.db, run.runId, "READBACK_MISMATCH", { taskId: result.taskId, failed: checks.filter((c) => !c.pass).map((c) => c.name) });
      return persist(deps.db, run);
    }
    run.execution.stateChange = {
      from: draftStatusBefore,
      to: draft.businessStatus,
      persisted: draftStatusBefore !== draft.businessStatus,
    };
    run.outcomeState = "EVIDENCE_REVIEW_PENDING";
    run.status = "COMPLETED";
    appendAppAudit(deps.db, run.runId, "EXECUTION_VERIFIED", { taskId: result.taskId, duplicate: result.duplicate, from: draftStatusBefore, to: draft.businessStatus });
    log("info", "run completed", { runId: run.runId, taskId: result.taskId, duplicate: result.duplicate });
    return persist(deps.db, run);
  } catch (err) {
    run.status = "FAILED";
    run.error = `Read-after-write failed: ${(err as Error).message}. The Task may exist; retry staging to replay idempotently.`;
    run.execution.readback = { task: null, checks: [], draftStatusAfter: null, draftVersionAfter: null, verified: false };
    appendAppAudit(deps.db, run.runId, "READBACK_FAILED", { message: (err as Error).message });
    // Allow an idempotent retry: replay returns the same task, then readback runs again.
    if (err instanceof UpstreamError && err.retryable) run.status = "FAILED_RETRYABLE";
    return persist(deps.db, run);
  }
}

/**
 * CH-0A. Repeats the checks that can change between evaluation and staging:
 * the age of the evaluation and the patient's Provider Access permission
 * (attribution and opt-out). Any failure stops before the tool is called.
 * Returns the persisted run when the write is refused, or null to continue.
 */
async function preWriteRecheck(
  deps: OrchestratorDeps,
  run: Run,
  t: Tracer,
  a: Adapters,
  input: CreateEvidenceReviewTaskInput,
): Promise<Run | null> {
  const now = (deps.now ?? (() => clockOf(deps.db).now()))();
  const ageMs = Math.max(0, now.getTime() - Date.parse(run.createdAt));
  const check: PreWriteCheck = {
    at: now.toISOString(),
    runAgeMinutes: Math.floor(ageMs / 60000),
    maxAgeMinutes: Math.floor(deps.maxRunAgeMs / 60000),
    ageOk: ageMs <= deps.maxRunAgeMs,
    access: null,
    accessOk: false,
    passed: false,
    refusal: null,
  };
  run.execution.preWriteCheck = check;
  const refuse = (status: Run["status"], outcome: Run["outcomeState"], reason: NonNullable<PreWriteCheck["refusal"]>, summary: string) => {
    check.refusal = reason;
    run.status = status;
    run.outcomeState = outcome;
    t.note("PRE_WRITE_RECHECK", "verification", false, summary, { check });
    appendAppAudit(deps.db, run.runId, "NO_ACTION", { reason, runAgeMinutes: check.runAgeMinutes });
    return persist(deps.db, run);
  };

  if (!check.ageOk) {
    return refuse("REEVALUATION_REQUIRED", "REEVALUATION_REQUIRED", "RUN_TOO_OLD",
      `Evaluation is ${check.runAgeMinutes} minutes old; the limit is ${check.maxAgeMinutes}. Run the evidence check again. Nothing was written.`);
  }
  try {
    check.access = await a.payer.checkAuthorization(input.syntheticPatientId, deps.requestingProviderOrgId, now.toISOString().slice(0, 10));
  } catch (err) {
    if (err instanceof UpstreamError) {
      run.execution.error = { kind: err.kind, status: err.status, message: err.message };
      return refuse(err.retryable ? "FAILED_RETRYABLE" : "FAILED", run.outcomeState, "ACCESS_CHECK_UNAVAILABLE",
        `Could not confirm Provider Access permission (${err.message}). Nothing was written.`);
    }
    throw err;
  }
  check.accessOk = check.access.decision === "PERMIT";
  if (!check.accessOk) {
    return refuse("NO_ACTION", "ACCESS_NOT_PERMITTED", "ACCESS_NOT_PERMITTED",
      `Access is no longer permitted: ${check.access.reasons.join(" ")} Nothing was written.`);
  }
  check.passed = true;
  t.note("PRE_WRITE_RECHECK", "verification", true,
    `Evaluation is ${check.runAgeMinutes} of ${check.maxAgeMinutes} minutes old; Provider Access still permitted.`, { check });
  return null;
}

/**
 * A transport failure (timeout, network, HTTP error) means the source is
 * unavailable. A contract failure (body did not match its schema, V3 CH-2) is
 * not: it fails the run, as malformed data did before CH-2.
 */
function isSourceFailure(err: unknown): err is UpstreamError {
  return err instanceof UpstreamError && err.kind !== "contract";
}
