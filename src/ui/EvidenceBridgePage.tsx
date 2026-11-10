import { useCallback, useEffect, useState } from "react";
import { eventsFor, track } from "./analytics";
import { ApiError, apiClient, type EvidenceCheck, type Role, type RunSummary, type Scenario, type SourceHistory, type TaskDue, type Workspace } from "./api";
import type { Run } from "../orchestrator/runTypes";
import { TechnicalInspector } from "./TechnicalInspector";
import { projectStaging, type StagingProjection } from "./projection";
import { compareCounts, comparisonSentence, type CountComparison } from "./compare";
import { statusBadges } from "./badges";
import { eligibleDemoSwitch } from "./roleSwitch";
import { STATE_MARK, STATE_TEXT, stepperFor } from "./stepper";
import { policyProvenance } from "./provenance";
import { CitationViewer } from "./CitationViewer";

type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

const HEADLINE: Record<string, { title: string; tone: Tone; banner: string; sub: string }> = {
  REVIEW_EXTERNAL_EVIDENCE: {
    title: "External PT evidence found — review before submission",
    tone: "ok",
    banner: "Candidate external documentation is available",
    sub: "Claims identified the source; an HIE discharge summary contains cited facts that require provider review.",
  },
  CLAIM_LEAD_ONLY: {
    title: "Claim leads found — no clinical document yet",
    tone: "warn",
    banner: "Follow up with the external provider",
    sub: "Claims show billed services at an outside clinic, but no clinical document was found. Claims do not prove completion or outcome.",
  },
  ACCESS_NOT_PERMITTED: {
    title: "External retrieval not permitted",
    tone: "bad",
    banner: "No external data was requested",
    sub: "Provider Access sharing is not permitted for this patient and provider. Obtain records through the usual channels.",
  },
  SOURCE_UNAVAILABLE: {
    title: "External source unavailable — nothing was evaluated",
    tone: "bad",
    banner: "A source did not respond after bounded retries",
    sub: "No evidence was evaluated and nothing was written. Try again later or obtain records manually.",
  },
  MANUAL_REVIEW: {
    title: "Candidate evidence needs manual review",
    tone: "warn",
    banner: "The document could not be verified automatically",
    sub: "Provenance, patient match or extraction checks did not pass. The document is not attached and no task is created by this slice.",
  },
  INSUFFICIENT_EVIDENCE: {
    title: "Evidence cannot be used as found",
    tone: "warn",
    banner: "Insufficient evidence for automated staging",
    sub: "A version, patient or lookback check failed. Nothing was written.",
  },
};

export function EvidenceBridgePage({ role, mode = null, onSwitchRole }: { role: Role; mode?: string | null; onSwitchRole?: (r: Role) => void }) {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCitations, setShowCitations] = useState(false);

  const refresh = useCallback(async () => {
    const [w, s] = await Promise.all([apiClient.workspace(), apiClient.scenarios()]);
    setWs(w);
    setScenarios(s.scenarios);
    setSelected((cur) => cur || s.active || s.scenarios[0]?.id || "");
  }, []);

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      const out = await fn();
      for (const ev of eventsFor(label, out)) track(ev);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message}` : (e as Error).message);
    } finally {
      await refresh().catch(() => undefined);
      setBusy(null);
    }
  };

  if (!ws) {
    return <div className="loading" role="status">{error ? `Could not load workspace: ${error}` : "Loading workspace…"}</div>;
  }

  const run = ws.run;
  const draft = ws.draft;
  const decision = run?.policyResult?.decision ?? null;
  const canStage = role === "pa-specialist" && (run?.status === "AWAITING_CONFIRMATION" || run?.status === "FAILED_RETRYABLE");
  const headline = pickHeadline(run);
  const stepper = stepperFor(run);

  return (
    <div className="page">
      <section className="scenario-bar" aria-label="Demo scenario">
        <div className="scenario-pick">
          <label htmlFor="scenario">Synthetic scenario</label>
          <div className="row">
            <select id="scenario" value={selected} onChange={(e) => setSelected(e.target.value)}>
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>{s.order}. {s.title}</option>
              ))}
            </select>
            <button className="btn secondary" disabled={!!busy || role === "viewer"} onClick={() => act("load", () => apiClient.loadScenario(selected))}>
              {busy === "load" ? "Resetting…" : "Load & reset"}
            </button>
          </div>
          <p className="hint">{scenarios.find((s) => s.id === selected)?.description} Loading resets all simulators to deterministic fixtures.</p>
          <p className="hint clock-line">
            {ws.clock.mode === "scenario" ? "Scenario time" : "System time"}: <strong>{fmtDateTime(ws.clock.now)}</strong>
            {ws.clock.mode === "scenario" && (ws.clock.offsetMs > 0 ? ` (moved forward ${Math.round(ws.clock.offsetMs / 3600_000)} h for the demo)` : " (fixed start for this scenario)")}
          </p>
        </div>
        <div className="stepper-wrap">
          <ol className="stepper" aria-label="Progress">
            {stepper.steps.map((s, i) => (
              <li key={s.label} className={s.state} aria-current={s.state === "current" ? "step" : undefined}>
                <span aria-hidden="true">{STATE_MARK[s.state] || i + 1}</span>
                {s.label}
                <span className="sr-only"> ({STATE_TEXT[s.state]})</span>
              </li>
            ))}
          </ol>
          {stepper.outcome && <p className="stepper-outcome">{stepper.outcome}</p>}
        </div>
      </section>

      <section className="header-row">
        <div>
          <h1>{headline.title}</h1>
          <p className="meta">
            Draft <strong>{ws.draftId}</strong>
            {draft && <> · v{draft.version} · {draft.businessStatus}</>}
            {" "}· Synthetic patient <strong>{draft?.patientId ?? "—"}</strong>
            {run?.context && <> · Age band {run.context.patientAgeBand} · {run.context.serviceRequestDescription}</>}
          </p>
        </div>
        <div className="safety-badge" role="note" aria-label="Safety boundary: no payer submission">
          <span className="dot" aria-hidden="true" />
          <span><small>SAFETY BOUNDARY</small><strong>NO PAYER SUBMISSION</strong></span>
        </div>
      </section>

      {error && <div className="alert bad" role="alert">{error}</div>}

      {!run && (
        <section className="start-panel">
          <h2>Start the pre-submission evidence check</h2>
          <p>
            This emits the EHR's <code>PriorAuthDraftCreated</code> event for <strong>{ws.draftId}</strong>. EvidenceBridge then checks the synthetic
            documentation checklist, verifies Provider Access permission, looks for external evidence and returns a deterministic decision.
            Nothing is written and nothing is sent to a payer during the check.
          </p>
          <button className="btn primary" disabled={!!busy || role !== "pa-specialist"} onClick={() => act("check", () => apiClient.check(ws.draftId))}>
            {busy === "check" ? "Checking sources…" : "Run evidence check"}
          </button>
          <DemoSwitch role={role} mode={mode} run={null} onSwitch={onSwitchRole} />
        </section>
      )}

      {run && (
        <>
          <DecisionBanner run={run} headline={headline} />
          <EvidenceChecks checks={ws.evidenceChecks} />
          <div className="cards">
            <MissingCard run={run} draftVersion={draft?.version ?? null} />
            <FoundCard run={run} history={ws.sourceHistory} onShowCitations={() => setShowCitations(true)} />
            <NextCard run={run} />
          </div>

          <section className="workflow" aria-label="Bounded evidence workflow">
            <div>
              <h2>Bounded evidence workflow</h2>
              <p className="muted">The system turns an unresolved documentation gap into owned review work without modifying the clinical chart.</p>
              <div className="transition">
                <div className="state before"><small>BEFORE</small><strong>{run.execution.stateChange?.from ?? run.context?.draft.businessStatus ?? "DRAFT_INCOMPLETE"}</strong></div>
                <svg className="arrow" viewBox="0 0 60 20" aria-hidden="true"><path d="M2 10h52m-9-7 9 7-9 7" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
                <div className={`state after ${run.status === "COMPLETED" ? "reached" : ""}`}>
                  <small>{run.status === "COMPLETED" ? "AFTER TOOL READBACK" : "TARGET"}</small>
                  <strong>{decision === "REVIEW_EXTERNAL_EVIDENCE" || run.status === "COMPLETED" ? "EVIDENCE_REVIEW_PENDING" : run.outcomeState ?? "—"}</strong>
                </div>
              </div>
            </div>
            <div className="action-col">
              {canStage ? (
                <button className="btn primary big" disabled={!!busy} onClick={() => act("stage", () => apiClient.stage(run.runId))}>
                  {busy === "stage" ? "Writing task and verifying…" : run.status === "FAILED_RETRYABLE" ? "Retry staging (same idempotency key)" : "Stage evidence review task"}
                </button>
              ) : (
                <button className={`btn primary big ${run.status === "COMPLETED" ? "done" : ""}`} disabled aria-disabled="true">
                  {run.status === "COMPLETED" ? "✓ Review task staged" : run.status === "AWAITING_CONFIRMATION" ? "PA specialist confirmation required" : "No task for this outcome"}
                </button>
              )}
              <DemoSwitch role={role} mode={mode} run={run} onSwitch={onSwitchRole} />
              <p className="hint">
                {run.status === "AWAITING_CONFIRMATION" ? "Writes one FHIR-like Task and verifies it by reading it back." : run.status === "COMPLETED" ? "The Task was read back independently from the EHR." : "Only REVIEW_EXTERNAL_EVIDENCE creates a task."}
              </p>
              <button className="btn link" disabled={!!busy || role !== "pa-specialist"} onClick={() => act("check", () => apiClient.check(ws.draftId))}>
                {busy === "check" ? "Checking…" : "Run the evidence check again"}
              </button>
            </div>
          </section>

          <div className="lower">
            <ResultPanel run={run} due={ws.taskDue.find((d) => d.taskId === run.execution.result?.taskId) ?? null} projection={projectStaging(run, ws.limits.maxRunAgeHours)} />
            <aside className="boundary">
              <h3>Decision boundary</h3>
              <dl>
                <dt className="agent">AGENT</dt><dd>Extracts cited facts from one document; may abstain. Cannot call tools.</dd>
                <dt className="policy">POLICY</dt><dd>Deterministic {run.policyResult?.policyVersion ?? "rules"}: access, provenance, versions, lookback.</dd>
                <dt className="tool">TOOL</dt><dd>Creates one review Task only. No chart write, no submission.</dd>
              </dl>
            </aside>
          </div>

          <CheckHistory runs={ws.runHistory} current={run} />

          <DemoControls
            disabled={!!busy || role !== "pa-specialist"}
            onRedeliver={() => act("check", () => apiClient.check(ws.draftId))}
            onEdit={() => act("edit", () => apiClient.simulateEdit(ws.draftId))}
            onAdvance={() => act("clock", () => apiClient.advanceClock(25))}
          />
          <TechnicalInspector run={run} tasks={ws.tasks} faults={ws.faults} />
          {showCitations && run.documentPages && run.extraction?.output && (
            <CitationViewer pages={run.documentPages} facts={run.extraction.output.facts} documentId={run.document?.id ?? ""} onClose={() => setShowCitations(false)} />
          )}
        </>
      )}
    </div>
  );
}

function pickHeadline(run: Run | null) {
  if (!run) return { title: "Prior-authorization draft is waiting for an evidence check", tone: "neutral" as Tone, banner: "", sub: "" };
  if (run.status === "COMPLETED") return { title: "Evidence review task staged and verified", tone: "ok" as Tone, banner: "Candidate external documentation is available", sub: HEADLINE.REVIEW_EXTERNAL_EVIDENCE!.sub };
  const refusal = run.execution.preWriteCheck?.refusal ?? null;
  if (refusal === "ACCESS_NOT_PERMITTED") {
    return { title: "Staging stopped: access is no longer permitted", tone: "bad" as Tone, banner: "Consent or attribution changed after the check", sub: "The final check before writing found that Provider Access is no longer permitted. Nothing was written." };
  }
  if (refusal === "RUN_TOO_OLD") {
    return { title: "This check is too old to act on", tone: "warn" as Tone, banner: "Run the evidence check again", sub: "Evidence and consent can change over time, so an old result cannot be staged. Nothing was written." };
  }
  if (refusal === "ACCESS_CHECK_UNAVAILABLE") {
    return { title: "Could not confirm access before writing", tone: "bad" as Tone, banner: "The Provider Access check did not respond", sub: "Nothing was written. You can try staging again." };
  }
  if (run.status === "REEVALUATION_REQUIRED" || run.outcomeState === "REEVALUATION_REQUIRED") {
    return { title: "Draft changed — re-evaluation required", tone: "warn" as Tone, banner: "The write failed closed", sub: "The draft version or policy version no longer matches the evaluated context. Nothing was written." };
  }
  if ((run.status === "FAILED" || run.status === "FAILED_RETRYABLE") && run.execution.confirmedBy) {
    return { title: "Staging could not be verified", tone: "bad" as Tone, banner: "The task write was not confirmed", sub: "The run is not reported as successful until the readback matches. See the result panel below." };
  }
  if (run.status === "FAILED" && !run.policyResult) return { title: "The evidence check failed", tone: "bad" as Tone, banner: "Run failed", sub: run.error ?? "" };
  if (run.policyResult?.ruleId === "R5_MULTIPLE_CANDIDATES") {
    return { title: "More than one candidate document found", tone: "warn" as Tone, banner: "Choose the right document before review", sub: "The same clinic has more than one summary for the same therapy period. This is often an amended copy. A person must decide which one applies; no task is created automatically." };
  }
  if (run.status === "NO_GAP") return { title: "Requirement already present in the local chart", tone: "ok" as Tone, banner: "No external search needed", sub: "The synthetic checklist item is satisfied by a local document; no external retrieval was performed." };
  const d = run.policyResult?.decision ?? "MANUAL_REVIEW";
  return HEADLINE[d] ?? HEADLINE.MANUAL_REVIEW!;
}

function DecisionBanner({ run, headline }: { run: Run; headline: { tone: Tone; banner: string; sub: string } }) {
  if (!headline.banner) return null;
  return (
    <section className={`banner ${headline.tone}`} aria-live="polite">
      <span className="banner-icon" aria-hidden="true">{headline.tone === "ok" ? "✓" : headline.tone === "bad" ? "!" : "i"}</span>
      <div>
        <strong>{headline.banner}</strong>
        <p>{headline.sub}</p>
      </div>
      {run.policyResult && (
        <div className="decision-chip">
          <small>DECISION</small>
          <strong>{run.policyResult.decision}</strong>
        </div>
      )}
    </section>
  );
}

function Card({ n, title, eyebrow, heading, children }: { n: number; title: string; eyebrow: string; heading: string; children: React.ReactNode }) {
  return (
    <article className="card" aria-labelledby={`card-${n}`}>
      <h2 className="card-label" id={`card-${n}`}><span className="num" aria-hidden="true">{n}</span>{title}</h2>
      <div className="card-body">
        <p className="eyebrow">{eyebrow}</p>
        <h3>{heading}</h3>
        <hr />
        {children}
      </div>
    </article>
  );
}

function MissingCard({ run, draftVersion }: { run: Run; draftVersion: number | null }) {
  const ctx = run.context;
  const provenance = policyProvenance(run);
  const stale = draftVersion !== null && draftVersion !== run.event.draftVersion;
  return (
    <Card n={1} title="What is missing" eyebrow={`SYNTHETIC POLICY · ${ctx?.policy.policyVersion ?? "—"}`} heading="Supervised PT documentation">
      <dl className="kv">
        <dt>Local chart status</dt>
        <dd className={ctx?.missingRequirement?.localStatus === "MISSING" ? "bad" : "good"}>{ctx?.missingRequirement?.localStatus ?? "—"}</dd>
        <dt>Requirement version</dt>
        <dd>{ctx ? `${ctx.policy.policyVersion.replace(/^SYN-SPINE-PA-/, "")} · ${ctx.policy.status}` : "—"}</dd>
        <dt>Draft version</dt>
        <dd className={stale ? "bad" : ""}>{run.event.draftVersion}{draftVersion !== null ? (stale ? ` · now v${draftVersion}` : " · current") : ""}</dd>
      </dl>
      {provenance && (
        <details className="provenance">
          <summary>About this policy version</summary>
          <dl>{provenance.map((r) => (<div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>))}</dl>
          <p className="muted">{run.context?.policy.label}</p>
        </details>
      )}
      <div className="note warn">
        <p className="note-title">WHY THE DRAFT IS HELD</p>
        <p>No PT summary is available in the local EHR.</p>
        <p>The system does not infer completion from claims.</p>
        <p>Human review is required before evidence is added.</p>
      </div>
    </Card>
  );
}

function FoundCard({ run, history, onShowCitations }: { run: Run; history: SourceHistory | null; onShowCitations: () => void }) {
  const facts = Object.fromEntries((run.extraction?.output?.facts ?? []).map((f) => [f.field, f]));
  const start = facts.therapy_start_date?.normalizedValue;
  const end = facts.therapy_end_date?.normalizedValue;
  const visits = facts.documented_visit_count?.normalizedValue;
  const weeks = start && end ? Math.round((Date.parse(String(end)) - Date.parse(String(start))) / (7 * 864e5)) : null;
  const unavailable = run.trace.find((t) => t.step === "SOURCE_UNAVAILABLE");
  return (
    <Card n={2} title="What was found" eyebrow={run.access?.decision === "PERMIT" ? "AUTHORIZED EXTERNAL SEARCH" : run.access ? "EXTERNAL SEARCH NOT PERMITTED" : "EXTERNAL SEARCH"} heading={run.document ? "Candidate PT evidence" : run.claims?.leadCount ? "Claim leads only" : "No external evidence"}>
      {run.access && run.access.decision !== "PERMIT" && (
        <div className="note bad"><p className="note-title">ACCESS DENIED BY PROVIDER ACCESS SERVER</p>{run.access.reasons.map((r) => <p key={r}>{r}</p>)}<p>No claims or HIE documents were requested.</p></div>
      )}
      {unavailable && <div className="note bad"><p className="note-title">SOURCE UNAVAILABLE</p><p>{unavailable.summary}</p></div>}
      {run.claims && (
        <div className="found-block">
          <p className="tag lead">PAYER CLAIM LEADS</p>
          <p>{run.claims.leadCount} adjudicated PT service line{run.claims.leadCount === 1 ? "" : "s"}</p>
          {run.claims.leadCount > 0 && <p className="muted">{fmtDate(run.claims.firstDate)}–{fmtDate(run.claims.lastDate)} · {run.claims.providerName}</p>}
          {history && <HistoryLine h={history} />}
        </div>
      )}
      {run.claims && (
        <div className="found-block">
          <p className="tag doc">HIE CLINICAL DOCUMENT</p>
          {run.document ? (
            <>
              <p>PT discharge summary · {run.document.id}</p>
              {run.candidates && run.candidates.length > 1 && <CandidateList candidates={run.candidates} />}
              {run.extraction?.output && !run.extraction.output.abstain ? (
                <p>Extracted: {weeks !== null ? `${weeks}-week range` : "date range"} · {visits ?? "?"} documented visits</p>
              ) : (
                <p className="warn-text">{run.extraction?.skippedReason ? `Not processed: ${run.extraction.skippedReason}` : "Extractor abstained — document is ambiguous"}</p>
              )}
              {run.claims && run.extraction?.output && !run.extraction.output.abstain && (
                <CountBars c={compareCounts(run.claims.leadCount, typeof visits === "number" ? visits : null)} />
              )}

              {run.documentPages && run.extraction?.output && run.extraction.output.facts.length > 0 && (
                <button className="btn link" onClick={onShowCitations}>View exact cited paragraph ↗</button>
              )}
            </>
          ) : (
            <p className="muted">{run.claims.leadCount ? "No clinical document found for the lead provider and dates." : "No lead to search with."}</p>
          )}
        </div>
      )}
      <ul className="badges" aria-label="Source statuses">
        {statusBadges(run).map((b) => (
          <li key={`${b.source}-${b.label}`} className={`badge ${b.tone}`}>
            <span className="badge-src">{b.source}</span> {b.label}: <strong>{b.value}</strong>
          </li>
        ))}
      </ul>
      <p className="claims-warning">Claims are leads, not proof of completion or outcome.</p>
    </Card>
  );
}

function NextCard({ run }: { run: Run }) {
  const d = run.policyResult?.decision;
  const createsTask = d === "REVIEW_EXTERNAL_EVIDENCE" && run.outcomeState === "EVIDENCE_REVIEW_PENDING";
  const items: string[] = createsTask
    ? ["Owner: PA specialist queue", "Review source and patient match", "Decide whether evidence belongs in packet", "Request clarification when needed"]
    : nextStepsFor(run);
  return (
    <Card n={3} title="What happens next" eyebrow={`DETERMINISTIC POLICY · ${run.policyResult?.policyVersion ?? "not evaluated"}${run.policyResult ? ` · ${run.policyResult.ruleId}` : ""}`} heading={createsTask ? "Create one review task" : "No task is created"}>
      <ul className="checklist">
        {items.map((i) => <li key={i} className={createsTask ? "ok" : "neutral"}>{i}</li>)}
      </ul>
      <div className="note ok">
        <p className="note-title">ACTION BOUNDARY</p>
        <p>No chart write · No payer submission</p>
        <p>No medical-necessity or approval prediction</p>
      </div>
    </Card>
  );
}

function nextStepsFor(run: Run): string[] {
  switch (run.outcomeState) {
    case "CLAIM_SOURCE_FOLLOWUP":
      return [`Request records from ${run.claims?.providerName ?? "the external provider"}`, "Do not state that therapy was completed", "Re-run the check when a document is available"];
    case "ACCESS_NOT_PERMITTED":
      return ["Respect the patient's sharing choice", "Obtain records through standard release channels", "No external data was retrieved"];
    case "SOURCE_UNAVAILABLE":
      return ["Retry the evidence check later", "Escalate if the source stays unavailable", "Nothing was written"];
    case "REEVALUATION_REQUIRED":
      return ["Reload the current draft", "Run the evidence check again for the new version", "The stale write was rejected"];
    case "MANUAL_REVIEW":
      return [...(run.policyResult?.reasons ?? []), "Do not attach the document automatically"];
    default:
      return run.policyResult?.reasons ?? ["Review the technical evidence"];
  }
}

function ResultPanel({ run, due, projection }: { run: Run; due: TaskDue | null; projection: StagingProjection | null }) {
  const ex = run.execution;
  const pre = ex.preWriteCheck;
  if (pre && pre.refusal) {
    const text =
      pre.refusal === "RUN_TOO_OLD"
        ? `This check was made ${pre.runAgeMinutes} minutes ago. The limit is ${pre.maxAgeMinutes} minutes. Run the evidence check again.`
        : pre.refusal === "ACCESS_NOT_PERMITTED"
          ? `Provider Access is no longer permitted: ${(pre.access?.reasons ?? []).join(" ")}`
          : "The Provider Access check did not respond, so permission could not be confirmed.";
    return (
      <section className={`result ${pre.refusal === "RUN_TOO_OLD" ? "warn" : "bad"}`} role="alert">
        <h3><span className="banner-icon" aria-hidden="true">!</span>Final check stopped the write</h3>
        <p>{text}</p>
        <p>No task was created. The draft is unchanged.</p>
      </section>
    );
  }
  if (run.status === "COMPLETED" && ex.result) {
    const checks = ex.readback?.checks ?? [];
    return (
      <section className="result ok" aria-live="polite">
        <h3><span className="banner-icon" aria-hidden="true">✓</span>Task {ex.result.taskId} staged and verified</h3>
        <p className="transition-text"><code>{ex.stateChange?.from}</code> → <code>{ex.stateChange?.to}</code>{ex.result.duplicate ? " (idempotent replay — no new task)" : ""}</p>
        <dl className="result-grid">
          <dt>Draft</dt><dd>{run.event.draftId}</dd>
          <dt>Owner</dt><dd>PA specialist queue</dd>
          <dt>Duplicate</dt><dd>{String(ex.result.duplicate)}</dd>
          <dt>Readback</dt><dd className="good">VERIFIED ({checks.filter((c) => c.pass).length}/{checks.length} checks)</dd>
          <dt>Chart mutation</dt><dd className="good">{ex.result.chartMutationPerformed ? "PERFORMED" : "NONE"}</dd>
          <dt>Payer submission</dt><dd className="good">{ex.result.payerSubmissionPerformed ? "PERFORMED" : "NONE"}</dd>
        </dl>
        {due && <DueLine due={due} />}
        <p className="result-foot">One missing evidence gap is now assigned, cited, and reviewable.</p>
      </section>
    );
  }
  if (run.status === "FAILED_RETRYABLE" && projection && !ex.readback) {
    return (
      <>
        <section className="result bad" role="alert">
          <h3><span className="banner-icon" aria-hidden="true">!</span>Staging did not complete, safe to retry</h3>
          <p>{run.error ?? ex.error?.message}</p>
        </section>
        <ProjectionPanel p={projection} />
      </>
    );
  }
  if (run.status === "FAILED" || run.status === "FAILED_RETRYABLE") {
    const failed = ex.readback?.checks.filter((c) => !c.pass) ?? [];
    return (
      <section className="result bad" role="alert">
        <h3><span className="banner-icon" aria-hidden="true">!</span>{run.status === "FAILED_RETRYABLE" ? "Staging did not complete — safe to retry" : "Execution not verified"}</h3>
        <p>{run.error ?? ex.error?.message}</p>
        {failed.length > 0 && (
          <ul className="failed-checks">{failed.map((c) => <li key={c.name}><strong>{c.name}</strong>: expected {c.expected}, read back {c.actual}</li>)}</ul>
        )}
        {ex.result && <p className="muted">The EHR reported {ex.result.taskId}; it is not shown as successful until readback matches.</p>}
      </section>
    );
  }
  if (run.status === "REEVALUATION_REQUIRED") {
    return (
      <section className="result warn" role="status">
        <h3><span className="banner-icon" aria-hidden="true">i</span>Write rejected — draft changed</h3>
        <p>The EHR rejected the task because the draft is now v{run.context?.draft.version} (event was v{run.event.draftVersion}). Nothing was written. Run the evidence check again.</p>
      </section>
    );
  }
  if (run.status === "AWAITING_CONFIRMATION" && projection) return <ProjectionPanel p={projection} />;
  return (
    <section className="result neutral" role="status">
      <h3>No action taken</h3>
      <p>Outcome: <code>{run.outcomeState ?? run.status}</code>. The draft remains <code>{run.context?.draft.businessStatus ?? "DRAFT_INCOMPLETE"}</code>; no task, chart write or payer submission occurred.</p>
    </section>
  );
}

function DemoControls({ disabled, onRedeliver, onEdit, onAdvance }: { disabled: boolean; onRedeliver: () => void; onEdit: () => void; onAdvance: () => void }) {
  return (
    <details className="demo-controls">
      <summary>Demo controls — failure and recovery drills</summary>
      <div className="demo-grid">
        <div>
          <button className="btn secondary" disabled={disabled} onClick={onRedeliver}>Redeliver the same event</button>
          <p className="hint">Re-emits the same <code>eventId</code>. Staging again replays the stored result (<code>duplicate: true</code>) instead of creating a second task.</p>
        </div>
        <div>
          <button className="btn secondary" disabled={disabled} onClick={onEdit}>Simulate another user editing the draft</button>
          <p className="hint">Bumps the draft version in the mock EHR. A staged task for the old version then fails optimistic concurrency.</p>
        </div>
        <div>
          <button className="btn secondary" disabled={disabled} onClick={onAdvance}>Move scenario time forward 25 hours</button>
          <p className="hint">The check result is then older than the 24-hour limit, so staging is refused and the check must be run again.</p>
        </div>
      </div>
    </details>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
}

/** CH-5: review due state, derived on read. Nothing moves forward automatically. */
function DueLine({ due }: { due: TaskDue }) {
  if (due.state === "OVERDUE") {
    return (
      <p className="due-line overdue" role="status">
        <strong>Review overdue by {due.hoursOverdue} h.</strong> It was due {fmtDateTime(due.dueAt)}. It stays with the PA specialist queue and is flagged as overdue there. Nothing is staged or sent automatically.
      </p>
    );
  }
  return (
    <p className={`due-line ${due.state === "DUE_SOON" ? "soon" : ""}`}>
      Review due {fmtDateTime(due.dueAt)} ({due.hoursLeft} h left{due.state === "DUE_SOON" ? ", due soon" : ""}).
    </p>
  );
}

/** CH-6: every candidate from the same source and period, with a neutral caveat. */
function CandidateList({ candidates }: { candidates: NonNullable<Run["candidates"]> }) {
  return (
    <div className="note warn candidates" role="note">
      <p className="note-title">{candidates.length} DOCUMENTS FOR THE SAME PERIOD</p>
      <ul>
        {candidates.map((c) => (
          <li key={c.id}>
            {c.id} · dated {c.date}
            {c.selected ? " · read by the extractor" : c.sameContentAsSelected ? " · same content as the one read" : " · different content"}
          </li>
        ))}
      </ul>
      <p>Matched on: same patient, same clinic, same document type, overlapping therapy period.</p>
      <p>This is often a normal amended copy. Decide which document applies.</p>
    </div>
  );
}

/** CH-7: read-only projection of what staging will do. No network call, nothing changes. */
function ProjectionPanel({ p }: { p: StagingProjection }) {
  return (
    <section className="result pending" aria-labelledby="proj-h">
      <h3 id="proj-h">What staging will do</h3>
      <p className="projection-note">Projection only. Nothing has changed yet. Staging can still be refused by the final checks.</p>
      <dl className="projection">
        <dt>Creates</dt>
        <dd>{p.taskEffect === "CREATE" ? "1 review task" : "1 review task, or returns the one already created (same idempotency key)"} for the {p.owner}</dd>
        <dt>Review due</dt><dd>{fmtDateTime(p.dueAt)}</dd>
        <dt>Draft</dt><dd>{p.draftId}: {p.fromStatus} to {p.toStatus}</dd>
        <dt>Task links</dt><dd>{p.claimLeadCount} claim lead record{p.claimLeadCount === 1 ? "" : "s"}, document {p.evidenceDocumentId} (hash {p.evidenceHashShort}…), policy {p.policyVersion}</dd>
        <dt>Does not change</dt><dd>{p.unchanged.join(" · ")}</dd>
        <dt>Checked again first</dt><dd>{p.finalChecks.join(" · ")}</dd>
        {p.stageableUntil && (<><dt>Can be staged until</dt><dd>{fmtDateTime(p.stageableUntil)}</dd></>)}
      </dl>
    </section>
  );
}

/** CH-8: this system's own past checks with the clinic (other drafts only). */
function HistoryLine({ h }: { h: SourceHistory }) {
  const label = `EvidenceBridge history with this clinic (last ${h.windowDays} days, other drafts)`;
  if (h.draftsChecked === 0) return <p className="history-line">{label}: no prior history.</p>;
  const parts = [
    h.taskCreated && `${h.taskCreated} review task${h.taskCreated === 1 ? "" : "s"} created`,
    h.manualReview && `${h.manualReview} sent to manual review`,
    h.waitingForStaging && `${h.waitingForStaging} waiting to be staged`,
    h.noTaskOther && `${h.noTaskOther} ended with no task`,
  ].filter(Boolean);
  return <p className="history-line">{label}: {h.draftsChecked} draft{h.draftsChecked === 1 ? "" : "s"} checked: {parts.join(", ")}.</p>;
}

/** CH-10: billed claim lines versus documented visits, proportional bars with printed counts. */
function CountBars({ c }: { c: CountComparison | null }) {
  if (!c) return null;
  const row = (label: string, value: number, width: number, cls: string) => (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <span className="bar-track" aria-hidden="true"><span className={`bar-fill ${cls}`} style={{ width: `${width}%` }} /></span>
      <span className="bar-value">{value}</span>
    </div>
  );
  return (
    <figure className="count-bars" aria-label={`Billed visit lines ${c.billed.value}, documented visits ${c.documented.value}`}>
      {row("Billed visit lines (claims)", c.billed.value, c.billed.widthPct, "billed")}
      {row("Documented visits (summary)", c.documented.value, c.documented.widthPct, "documented")}
      <figcaption className={c.relation === "EQUAL" ? "" : "warn-text"}>{comparisonSentence(c)}</figcaption>
    </figure>
  );
}

const STATUS_WORDS: Record<string, string> = {
  COMPLETED: "task staged and verified", AWAITING_CONFIRMATION: "waiting to be staged", NO_ACTION: "no task", NO_GAP: "nothing missing",
  REEVALUATION_REQUIRED: "needs a new check", FAILED_RETRYABLE: "did not finish, safe to retry", FAILED: "failed", EXECUTING: "writing", EVALUATING: "checking",
};

/**
 * CH-11: every check made for this draft, oldest first. The latest is the one
 * on screen; earlier ones sit behind a keyboard-operable disclosure. Open by
 * default only when the current check still needs a response.
 */
function CheckHistory({ runs, current }: { runs: RunSummary[]; current: Run }) {
  const earlier = runs.filter((r) => r.runId !== current.runId);
  const position = runs.findIndex((r) => r.runId === current.runId) + 1;
  const needsResponse = current.status === "AWAITING_CONFIRMATION" || current.status === "FAILED_RETRYABLE";
  return (
    <section className="check-history" aria-label="Checks for this draft">
      <p className="muted">
        Showing check {position || runs.length} of {runs.length} for this draft: {STATUS_WORDS[current.status] ?? current.status}.
      </p>
      {earlier.length > 0 && (
        <details open={needsResponse}>
          <summary>View earlier checks ({earlier.length})</summary>
          <ol>
            {earlier.map((r) => (
              <li key={r.runId}>
                {fmtDateTime(r.createdAt)} · event {r.eventId}{r.deliveryCount > 1 ? ` (delivery ${r.deliveryCount})` : ""} · {r.decision ?? "no decision"} · {STATUS_WORDS[r.status] ?? r.status}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

/** CH-13: inline demo role switch on a blocked action. Demo identity only, never authentication. */
function DemoSwitch({ role, mode, run, onSwitch }: { role: Role; mode: string | null; run: Run | null; onSwitch?: (r: Role) => void }) {
  const offer = eligibleDemoSwitch(role, mode, run);
  if (!offer || !onSwitch) return null;
  return (
    <div className="demo-switch" role="note">
      <span>Your demo role cannot {offer.action === "check" ? "run the check" : "stage this task"}.</span>
      <button className="btn secondary" onClick={() => onSwitch(offer.to)}>Demo: switch to PA specialist</button>
      <span className="muted">Demo identity only, not a real sign-in. The server still checks the role.</span>
    </div>
  );
}

const CHECK_WORD: Record<EvidenceCheck["status"], string> = { PASS: "Passed", WARN: "Needs a person", FAIL: "Did not pass", NOT_EVALUATED: "Not evaluated" };

/**
 * CH-19: the deterministic checks that actually ran, as recorded by the server.
 * Read-only. It cannot stage anything; the server decides.
 */
function EvidenceChecks({ checks }: { checks: EvidenceCheck[] }) {
  if (checks.length === 0) return null;
  const n = (s: EvidenceCheck["status"]) => checks.filter((c) => c.status === s).length;
  return (
    <details className="evidence-checks">
      <summary>
        <strong>Evidence checks:</strong> {n("PASS")} passed, {n("WARN")} need a person, {n("FAIL")} did not pass, {n("NOT_EVALUATED")} not evaluated
      </summary>
      <p className="muted">Recorded results of the rules that ran for this check. A check that did not run is shown as not evaluated, never as passed.</p>
      <table className="mini">
        <thead><tr><th>Check</th><th>Result</th><th>What it found</th><th>Evidence</th><th>Stops the task if not passed</th></tr></thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.checkId}>
              <td>{c.label}</td>
              <td className={`check-${c.status.toLowerCase()}`}>{CHECK_WORD[c.status]}</td>
              <td>{c.detail}</td>
              <td>{c.evidenceRefs.length ? c.evidenceRefs.slice(0, 3).join(", ") + (c.evidenceRefs.length > 3 ? ` and ${c.evidenceRefs.length - 3} more` : "") : "None"}</td>
              <td>{c.blocksAutoAction ? "Yes" : "No"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
