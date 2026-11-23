import { useCallback, useEffect, useRef, useState } from "react";
import { eventsFor, track } from "./analytics";
import { ApiError, apiClient, type EvidenceCheck, type Role, type RunSummary, type Scenario, type SourceHistory, type TaskDue, type WorklistItem, type Workspace } from "./api";
import type { Run } from "../orchestrator/runTypes";
import { TechnicalInspector } from "./TechnicalInspector";
import { projectStaging, type StagingProjection } from "./projection";
import { compareCounts, comparisonSentence, type CountComparison } from "./compare";
import { statusBadges } from "./badges";
import { eligibleDemoSwitch } from "./roleSwitch";
import { STATE_MARK, STATE_TEXT, stepperFor } from "./stepper";
import { policyProvenance } from "./provenance";
import { CitationViewer } from "./CitationViewer";
import { Worklist } from "./Worklist";
import { defaultSelection, nextNeedingYou, uncheckedDrafts } from "./worklist";
import { ConfirmSheet } from "./ConfirmSheet";
import { WhyPanel } from "./WhyPanel";
import { DemoLab } from "./DemoLab";
import { EvidencePacket } from "./EvidencePacket";
import { GuidedTour } from "./GuidedTour";
import { tourSteps, type UiMode } from "./pitch";
import { PACKET, STAGE, START, STATUS_WORD, draftStatusWords, outcomeWords } from "./copy";
import { ErrorNote, Skeleton } from "./states";

type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

/** Layer 0 headlines. h1 titles are unchanged (e2e contract); banners and subs are plain language (Product P4). */
const HEADLINE: Record<string, { title: string; tone: Tone; banner: string; sub: string }> = {
  REVIEW_EXTERNAL_EVIDENCE: {
    title: "External PT evidence found — review before submission",
    tone: "ok",
    banner: "Outside physical therapy records were found",
    sub: "Insurance claims pointed to an outside clinic, and its discharge summary was found. Its facts are quoted word for word. A person should review it before the request is submitted.",
  },
  CLAIM_LEAD_ONLY: {
    title: "Claim leads found — no clinical document yet",
    tone: "warn",
    banner: "Ask the outside clinic for the therapy notes",
    sub: "Claims show therapy was billed at an outside clinic, but no clinical document was found. A bill does not prove the therapy was completed.",
  },
  ACCESS_NOT_PERMITTED: {
    title: "External retrieval not permitted",
    tone: "bad",
    banner: "No outside records were requested",
    sub: "This patient's sharing choice or the payer's records do not allow an outside search for this provider. Use your usual records request.",
  },
  SOURCE_UNAVAILABLE: {
    title: "External source unavailable — nothing was evaluated",
    tone: "bad",
    banner: "An outside source did not answer",
    sub: "It was tried a few times. No evidence was evaluated and nothing was written. Try again later or request records by hand.",
  },
  MANUAL_REVIEW: {
    title: "Candidate evidence needs manual review",
    tone: "warn",
    banner: "A person needs to look at the document",
    sub: "One of the safety checks (document unchanged, same patient, exact quotes) did not pass. The document was not attached and no task was created.",
  },
  INSUFFICIENT_EVIDENCE: {
    title: "Evidence cannot be used as found",
    tone: "warn",
    banner: "The evidence cannot be used as found",
    sub: "A version, patient or date check did not pass. Nothing was written.",
  },
};

export function EvidenceBridgePage({ role, mode = null, onSwitchRole, uiMode = "demo", selectedDraft, onSelectDraft }: {
  role: Role;
  mode?: string | null;
  onSwitchRole?: (r: Role) => void;
  uiMode?: UiMode;
  selectedDraft: string | null;
  onSelectDraft: (id: string | null) => void;
}) {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [activeScenario, setActiveScenario] = useState<string | null>(null);
  const [pickScenario, setPickScenario] = useState<string>("");
  const [items, setItems] = useState<WorklistItem[] | null>(null);
  const [wlError, setWlError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCitations, setShowCitations] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [packet, setPacket] = useState(false);
  const [packetOpened, setPacketOpened] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [tourHidden, setTourHidden] = useState(() => { try { return window.sessionStorage.getItem("eb.tour.hidden") === "1"; } catch { return false; } });
  const [tourError, setTourError] = useState<string | null>(null);

  /** The draft the last refresh loaded, so choosing the default selection does not load it twice. */
  const loaded = useRef<string | null | undefined>(undefined);

  const loadWorklist = useCallback(async () => {
    try {
      const wl = await apiClient.worklist();
      setItems(wl.items);
      setWlError(null);
      return wl.items;
    } catch (e) {
      setWlError((e as Error).message);
      return null;
    }
  }, []);

  const refresh = useCallback(async (draftId: string | null) => {
    const [list, s] = await Promise.all([loadWorklist(), apiClient.scenarios()]);
    setScenarios(s.scenarios);
    setActiveScenario(s.active);
    setPickScenario((cur) => cur || s.active || s.scenarios[0]?.id || "");
    const target = draftId ?? (list ? defaultSelection(list) : null);
    const w = await apiClient.workspace(target);
    loaded.current = w.draftId;
    setWs(w);
    setLoadError(null);
    if (!draftId && target) onSelectDraft(target);
  }, [loadWorklist, onSelectDraft]);

  useEffect(() => {
    // Load on mount and whenever the user picks another draft.
    if (selectedDraft !== null && selectedDraft === loaded.current) return;
    refresh(selectedDraft).catch((e: Error) => setLoadError(e.message));
  }, [refresh, selectedDraft]);

  const act = async (label: string, fn: () => Promise<unknown>, after: string | null = selectedDraft) => {
    setBusy(label);
    setError(null);
    try {
      const out = await fn();
      for (const ev of eventsFor(label, out)) track(ev);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message}` : (e as Error).message);
    } finally {
      await refresh(after).catch(() => undefined);
      setBusy(null);
    }
  };

  /** Product P3: read-only bulk check. One existing /check call per unchecked draft, in order; never stages. */
  const checkAll = async () => {
    if (!items) return;
    const ids = uncheckedDrafts(items);
    setBusy("check-all");
    setError(null);
    setProgress({ done: 0, total: ids.length });
    const failed: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      try { await apiClient.check(ids[i]!); } catch (e) { failed.push(`${ids[i]}: ${(e as Error).message}`); }
      setProgress({ done: i + 1, total: ids.length });
      await loadWorklist();
    }
    if (ids.length) track("evidence_check_run");
    setProgress(null);
    if (failed.length) setError(`Some checks did not run: ${failed.join("; ")}`);
    await refresh(selectedDraft).catch(() => undefined);
    setBusy(null);
  };

  if (loadError && !ws) return <ErrorNote what="This draft could not be loaded." detail={loadError} onRetry={() => refresh(selectedDraft).catch((e: Error) => setLoadError(e.message))} />;
  if (!ws) return <div className="review-layout"><Skeleton lines={6} label="Loading workspace" /></div>;

  const run = ws.run;
  const draft = ws.draft;
  const canStage = role === "pa-specialist" && (run?.status === "AWAITING_CONFIRMATION" || run?.status === "FAILED_RETRYABLE");
  const headline = pickHeadline(run);
  const stepper = stepperFor(run);
  const projection = run ? projectStaging(run, ws.limits.maxRunAgeHours) : null;
  const pitch = uiMode === "pitch";
  const steps = tourSteps({ items: items ?? [], selectedStatus: run?.status ?? null, packetOpened });
  const next = items ? nextNeedingYou(items, ws.draftId) : null;

  const loadScenario = (id: string) => act("load", async () => {
    const out = await apiClient.loadScenario(id);
    onSelectDraft(null);
    return out;
  }, null);

  return (
    <div className="review-layout">
      {!pitch && (
        <DemoLab
          scenarios={scenarios}
          selected={pickScenario}
          onSelect={setPickScenario}
          activeId={activeScenario}
          clock={ws.clock}
          busy={busy}
          canLoad={role !== "viewer"}
          canDrill={role === "pa-specialist"}
          onLoad={() => loadScenario(pickScenario)}
          onRedeliver={() => act("check", () => apiClient.check(ws.draftId))}
          onEdit={() => act("edit", () => apiClient.simulateEdit(ws.draftId))}
          onAdvance={() => act("clock", () => apiClient.advanceClock(25))}
          fmt={fmtDateTime}
        />
      )}
      {pitch && !tourHidden && (
        <GuidedTour
          steps={steps}
          busy={!!busy}
          error={tourError}
          onHide={() => { setTourHidden(true); try { window.sessionStorage.setItem("eb.tour.hidden", "1"); } catch { /* not remembered */ } }}
          onStartFresh={() => { setTourError(null); setPacketOpened(false); apiClient.loadScenario("primary-success").then(() => { onSelectDraft(null); return refresh(null); }).catch((e: Error) => setTourError(e.message)); }}
        />
      )}

      <div className="review-grid">
        <Worklist
          items={items}
          selected={ws.draftId}
          onSelect={(id) => { setError(null); onSelectDraft(id); }}
          onCheckAll={checkAll}
          progress={progress}
          canCheck={role === "pa-specialist"}
          busy={!!busy}
          error={wlError}
        />

        <div className="detail" aria-label="Selected draft">
          <section className="header-row">
            <div>
              <p className="eyebrow">Prior-authorization draft</p>
              <h1>{headline.title}</h1>
              <p className="meta">
                Draft <strong>{ws.draftId}</strong>
                {draft && <> · version {draft.version} · {draftStatusWords(draft.businessStatus)}</>}
                {" "}· Synthetic patient <strong>{draft?.patientId ?? "—"}</strong>
                {run?.context && <> · age {run.context.patientAgeBand} · {run.context.serviceRequestDescription}</>}
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

          {error && <div className="alert bad" role="alert"><p><strong>{error}</strong></p><p>Nothing else was changed.</p></div>}

          <NextStep
            run={run}
            headline={headline}
            busy={busy}
            role={role}
            canStage={canStage}
            onCheck={() => act("check", () => apiClient.check(ws.draftId))}
            onStage={() => setConfirming(true)}
            onPacket={() => { setPacket(true); setPacketOpened(true); }}
            next={next && run && run.status !== "AWAITING_CONFIRMATION" && run.status !== "FAILED_RETRYABLE" ? { id: next.draftId, onGo: () => { setError(null); onSelectDraft(next.draftId); window.scrollTo({ top: 0 }); } } : null}
            demoSwitch={<DemoSwitch role={role} mode={mode} run={run} onSwitch={onSwitchRole} />}
          />

          {run && (
            <>
              <ResultPanel run={run} due={ws.taskDue.find((d) => d.taskId === run.execution.result?.taskId) ?? null} projection={projection} />
              <EvidenceChecks checks={ws.evidenceChecks} />
              <div className="cards">
                <MissingCard run={run} draftVersion={draft?.version ?? null} />
                <FoundCard run={run} history={ws.sourceHistory} onShowCitations={() => setShowCitations(true)} />
                <NextCard run={run} />
              </div>
              <CheckHistory runs={ws.runHistory} current={run} />
              <WhyPanel run={run} checks={ws.evidenceChecks} />
              <TechnicalInspector run={run} tasks={ws.tasks} faults={ws.faults} checks={ws.evidenceChecks} />
              {showCitations && run.documentPages && run.extraction?.output && (
                <CitationViewer pages={run.documentPages} facts={run.extraction.output.facts} documentId={run.document?.id ?? ""} onClose={() => setShowCitations(false)} />
              )}
              {confirming && (
                <ConfirmSheet
                  p={projection}
                  fmt={fmtDateTime}
                  onCancel={() => setConfirming(false)}
                  onConfirm={() => { setConfirming(false); void act("stage", () => apiClient.stage(run.runId)); }}
                />
              )}
              {packet && <EvidencePacket run={run} checks={ws.evidenceChecks} generatedAt={fmtDateTime(ws.clock.now)} onClose={() => setPacket(false)} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Layer 0: the one thing to do next, with one primary button and what it does. */
function NextStep({ run, headline, busy, role, canStage, onCheck, onStage, onPacket, demoSwitch, next }: {
  next: { id: string; onGo: () => void } | null;
  run: Run | null;
  headline: { tone: Tone; banner: string; sub: string };
  busy: string | null;
  role: Role;
  canStage: boolean;
  onCheck: () => void;
  onStage: () => void;
  onPacket: () => void;
  demoSwitch: React.ReactNode;
}) {
  if (!run) {
    return (
      <section className="next-step neutral start-panel" aria-labelledby="next-h">
        <div className="next-text">
          <p className="eyebrow">Next step</p>
          <h2 id="next-h">Check this draft for missing evidence</h2>
          <p>{START.lead}</p>
          <p className="muted">{START.safe}</p>
        </div>
        <div className="next-action">
          <button className="btn primary big" disabled={!!busy || role !== "pa-specialist"} onClick={onCheck}>
            {busy === "check" ? START.busy : START.button}
          </button>
          {demoSwitch}
        </div>
      </section>
    );
  }
  const completed = run.status === "COMPLETED";
  return (
    <section className={`next-step banner ${headline.tone}`} aria-live="polite" aria-labelledby="next-h">
      <div className="next-text">
        <p className="eyebrow">{completed ? "Done" : "Next step"}</p>
        <h2 id="next-h"><span className="banner-icon" aria-hidden="true">{headline.tone === "ok" ? "✓" : headline.tone === "bad" ? "!" : "i"}</span>{headline.banner || "Result"}</h2>
        <p>{headline.sub}</p>
      </div>
      <div className="next-action">
        {canStage ? (
          <button className="btn primary big" disabled={!!busy} onClick={onStage}>
            {busy === "stage" ? STAGE.busy : run.status === "FAILED_RETRYABLE" ? STAGE.retry : STAGE.button}
          </button>
        ) : (
          <button className={`btn big ${completed ? "primary done" : "quiet"}`} disabled aria-disabled="true">
            {completed ? STAGE.done : run.status === "AWAITING_CONFIRMATION" ? STAGE.needsRole : STAGE.none}
          </button>
        )}
        <p className="hint">{canStage || run.status === "AWAITING_CONFIRMATION" ? STAGE.doesWhat : completed ? STAGE.doneWhat : STAGE.noneWhat}</p>
        {demoSwitch}
        <div className="next-links">
          <button className="btn link" disabled={!!busy || role !== "pa-specialist"} onClick={onCheck}>
            {busy === "check" ? "Checking…" : STAGE.again}
          </button>
          {run.policyResult && <button className="btn link" onClick={onPacket}>{PACKET.button}</button>}
          <a className="btn link" href="#why">See why</a>
        </div>
        {next && <button className="btn secondary" onClick={next.onGo}>Next draft that needs you: {next.id.replace(/^PA-DRAFT-/, "Draft ")} ›</button>}
      </div>
    </section>
  );
}

function pickHeadline(run: Run | null) {
  if (!run) return { title: "Prior-authorization draft is waiting for an evidence check", tone: "neutral" as Tone, banner: "", sub: "" };
  if (run.status === "COMPLETED") return { title: "Evidence review task staged and verified", tone: "ok" as Tone, banner: "Review task created and checked", sub: "The task is with the PA specialist team. The draft now shows “Evidence review pending”. The chart was not changed and nothing went to the payer." };
  const refusal = run.execution.preWriteCheck?.refusal ?? null;
  if (refusal === "ACCESS_NOT_PERMITTED") {
    return { title: "Staging stopped: access is no longer permitted", tone: "bad" as Tone, banner: "The patient's sharing choice changed after the check", sub: "The final check before writing found that outside records may no longer be used. Nothing was written." };
  }
  if (refusal === "RUN_TOO_OLD") {
    return { title: "This check is too old to act on", tone: "warn" as Tone, banner: "Run the evidence check again", sub: "Records and permissions can change, so an old result cannot be used to create a task. Nothing was written." };
  }
  if (refusal === "ACCESS_CHECK_UNAVAILABLE") {
    return { title: "Could not confirm access before writing", tone: "bad" as Tone, banner: "The permission check did not answer", sub: "Nothing was written. You can try staging again." };
  }
  if (run.status === "REEVALUATION_REQUIRED" || run.outcomeState === "REEVALUATION_REQUIRED") {
    return { title: "Draft changed — re-evaluation required", tone: "warn" as Tone, banner: "The draft or checklist changed", sub: "The draft or its checklist version no longer matches what was checked, so nothing was written. Run the check again." };
  }
  if ((run.status === "FAILED" || run.status === "FAILED_RETRYABLE") && run.execution.confirmedBy) {
    return { title: "Staging could not be verified", tone: "bad" as Tone, banner: "The saved task could not be confirmed", sub: "It is not shown as done until the read-back matches. See the result below." };
  }
  if (run.status === "FAILED" && !run.policyResult) return { title: "The evidence check failed", tone: "bad" as Tone, banner: "The check did not finish", sub: run.error ?? "" };
  if (run.policyResult?.ruleId === "R5_MULTIPLE_CANDIDATES") {
    return { title: "More than one candidate document found", tone: "warn" as Tone, banner: "Choose the right document before review", sub: "The same clinic has more than one summary for the same therapy period. This is often an amended copy. A person must decide which one applies; no task is created automatically." };
  }
  if (run.status === "NO_GAP") return { title: "Requirement already present in the local chart", tone: "ok" as Tone, banner: "Nothing is missing", sub: "The checklist item is already in your chart, so no outside search was needed." };
  const d = run.policyResult?.decision ?? "MANUAL_REVIEW";
  return HEADLINE[d] ?? HEADLINE.MANUAL_REVIEW!;
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
  const local = ctx?.missingRequirement?.localStatus;
  return (
    <Card n={1} title="What is missing" eyebrow="Synthetic checklist for this procedure" heading="Supervised PT documentation">
      <dl className="kv">
        <dt>In your chart</dt>
        <dd className={local === "MISSING" ? "bad" : "good"}>{local === "MISSING" ? "Missing" : local === "PRESENT" ? "Present" : "—"}</dd>
        <dt>Checklist in effect</dt>
        <dd>{ctx ? (ctx.policy.status === "ACTIVE" ? "Current" : "Not current") : "—"}</dd>
        <dt>Draft version</dt>
        <dd className={stale ? "bad" : ""}>{run.event.draftVersion}{draftVersion !== null ? (stale ? ` · now ${draftVersion}` : " · current") : ""}</dd>
      </dl>
      {provenance && (
        <details className="provenance">
          <summary>About this policy version</summary>
          <dl>{provenance.map((r) => (<div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>))}</dl>
          <p className="muted">{run.context?.policy.label}</p>
        </details>
      )}
      <div className="note warn">
        <p className="note-title">Why the draft is on hold</p>
        <p>No PT summary is in your chart.</p>
        <p>Claims alone never count as proof.</p>
        <p>A person reviews any evidence before it is used.</p>
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
    <Card n={2} title="What was found" eyebrow={run.access?.decision === "PERMIT" ? "Outside search, permitted" : run.access ? "Outside search not permitted" : "Outside search"} heading={run.document ? "Candidate PT evidence" : run.claims?.leadCount ? "Claim leads only" : "No external evidence"}>
      {run.access && run.access.decision !== "PERMIT" && (
        <div className="note bad"><p className="note-title">Access denied by the payer's permission check</p>{run.access.reasons.map((r) => <p key={r}>{r}</p>)}<p>No claims or HIE documents were requested.</p></div>
      )}
      {unavailable && <div className="note bad"><p className="note-title">Source unavailable</p><p>{unavailable.summary}</p></div>}
      {run.claims && (
        <div className="found-block">
          <p className="tag lead">Insurance claims (leads only)</p>
          <p>{run.claims.leadCount} billed PT visit line{run.claims.leadCount === 1 ? "" : "s"}</p>
          {run.claims.leadCount > 0 && <p className="muted">{fmtDate(run.claims.firstDate)}–{fmtDate(run.claims.lastDate)} · {run.claims.providerName}</p>}
          {history && <HistoryLine h={history} />}
        </div>
      )}
      {run.claims && (
        <div className="found-block">
          <p className="tag doc">Clinical document from the shared-record network</p>
          {run.document ? (
            <>
              <p>PT discharge summary · {run.document.id}</p>
              {run.candidates && run.candidates.length > 1 && <CandidateList candidates={run.candidates} />}
              {run.extraction?.output && !run.extraction.output.abstain ? (
                <p>Found: {weeks !== null ? `${weeks}-week course` : "date range"} · {visits ?? "?"} documented visits</p>
              ) : (
                <p className="warn-text">{run.extraction?.skippedReason ? `Not read: ${run.extraction.skippedReason}` : "The reader was not sure, so it did not extract facts"}</p>
              )}
              {run.claims && run.extraction?.output && !run.extraction.output.abstain && (
                <CountBars c={compareCounts(run.claims.leadCount, typeof visits === "number" ? visits : null)} />
              )}
              {run.documentPages && run.extraction?.output && run.extraction.output.facts.length > 0 && (
                <button className="btn link" onClick={onShowCitations}>View exact cited paragraph ↗</button>
              )}
            </>
          ) : (
            <p className="muted">{run.claims.leadCount ? "No clinical document found for that clinic and those dates." : "No lead to search with."}</p>
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
    ? ["Owner: PA specialist team", "Check the source and that it is the same patient", "Decide whether the evidence belongs in the request", "Ask for clarification when needed"]
    : nextStepsFor(run);
  return (
    <Card n={3} title="What happens next" eyebrow={run.policyResult ? "Fixed rules: same answer every time" : "Not decided"} heading={createsTask ? "Create one review task" : "No task is created"}>
      <ul className="checklist">
        {items.map((i) => <li key={i} className={createsTask ? "ok" : "neutral"}>{i}</li>)}
      </ul>
      <div className="note ok">
        <p className="note-title">What this system never does</p>
        <p>No chart write · No payer submission</p>
        <p>No medical-necessity or approval prediction</p>
      </div>
    </Card>
  );
}

function nextStepsFor(run: Run): string[] {
  switch (run.outcomeState) {
    case "CLAIM_SOURCE_FOLLOWUP":
      return [`Request records from ${run.claims?.providerName ?? "the outside clinic"}`, "Do not state that therapy was completed", "Run the check again when a document is available"];
    case "ACCESS_NOT_PERMITTED":
      return ["Respect the patient's sharing choice", "Request records through your usual release process", "No outside data was retrieved"];
    case "SOURCE_UNAVAILABLE":
      return ["Run the check again later", "Escalate if the source stays unavailable", "Nothing was written"];
    case "REEVALUATION_REQUIRED":
      return ["Reload the current draft", "Run the evidence check again for the new version", "The out-of-date write was refused"];
    case "MANUAL_REVIEW":
      return [...(run.policyResult?.reasons ?? []), "Do not attach the document automatically"];
    default:
      return run.policyResult?.reasons ?? ["See Technical evidence for details"];
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
          ? `Outside records may no longer be used: ${(pre.access?.reasons ?? []).join(" ")}`
          : "The permission check did not answer, so permission could not be confirmed.";
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
        <p className="transition-text">Draft status: {draftStatusWords(ex.stateChange?.from)} → <strong>{draftStatusWords(ex.stateChange?.to)}</strong>{ex.result.duplicate ? " (the task made earlier was returned; no duplicate)" : ""}</p>
        <dl className="result-grid">
          <dt>Draft</dt><dd>{run.event.draftId}</dd>
          <dt>Owner</dt><dd>PA specialist team</dd>
          <dt>New task</dt><dd>{ex.result.duplicate ? "No, same task returned" : "Yes"}</dd>
          <dt>Read back</dt><dd className="good">VERIFIED ({checks.filter((c) => c.pass).length}/{checks.length} checks)</dd>
          <dt>Chart changed</dt><dd className="good">{ex.result.chartMutationPerformed ? "Yes" : "No"}</dd>
          <dt>Sent to payer</dt><dd className="good">{ex.result.payerSubmissionPerformed ? "Yes" : "No"}</dd>
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
          <p>Trying again cannot create a second task.</p>
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
        {ex.result && <p className="muted">The record system reported {ex.result.taskId}; it is not shown as done until the read-back matches.</p>}
      </section>
    );
  }
  if (run.status === "REEVALUATION_REQUIRED") {
    return (
      <section className="result warn" role="status">
        <h3><span className="banner-icon" aria-hidden="true">i</span>Write rejected — draft changed</h3>
        <p>The record system refused the task because the draft is now version {run.context?.draft.version} (the check was for version {run.event.draftVersion}). Nothing was written. Run the evidence check again.</p>
      </section>
    );
  }
  if (run.status === "AWAITING_CONFIRMATION" && projection) return <ProjectionPanel p={projection} />;
  return (
    <section className="result neutral" role="status">
      <h3>No action taken</h3>
      <p>Outcome: <strong>{outcomeWords(run.outcomeState ?? run.status)}</strong>. The draft stays “{draftStatusWords(run.context?.draft.businessStatus ?? "DRAFT_INCOMPLETE")}”. No task, chart change or payer submission happened.</p>
    </section>
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
        <strong>Review overdue by {due.hoursOverdue} h.</strong> It was due {fmtDateTime(due.dueAt)}. It stays with the PA specialist team and is flagged as overdue there. Nothing is staged or sent automatically.
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
            {c.selected ? " · the one that was read" : c.sameContentAsSelected ? " · same content as the one read" : " · different content"}
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
        <dd>{p.taskEffect === "CREATE" ? "1 review task" : "1 review task, or returns the one already created (no duplicate)"} for the {p.owner}</dd>
        <dt>Review due</dt><dd>{fmtDateTime(p.dueAt)}</dd>
        <dt>Draft</dt><dd>{p.draftId}: “{draftStatusWords(p.fromStatus)}” becomes “{draftStatusWords(p.toStatus)}”</dd>
        <dt>Task links</dt><dd>{p.claimLeadCount} claim lead record{p.claimLeadCount === 1 ? "" : "s"}, document {p.evidenceDocumentId} (fingerprint {p.evidenceHashShort}…)</dd>
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

/**
 * CH-19: the deterministic checks that actually ran, as recorded by the server.
 * Read-only. It cannot stage anything; the server decides. Record references
 * are in Technical evidence (Layer 2).
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
      <div className="table-wrap">
        <table className="mini">
          <thead><tr><th>Check</th><th>Result</th><th>What it found</th><th>Stops the task if not passed</th></tr></thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.checkId}>
                <td>{c.label}</td>
                <td className={`check-${c.status.toLowerCase()}`}>{c.status === "NOT_EVALUATED" ? "Not evaluated" : STATUS_WORD[c.status]}</td>
                <td>{c.detail}</td>
                <td>{c.blocksAutoAction ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
