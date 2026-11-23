/**
 * Product P8 (spec CH-2.3): a human-readable evidence summary for print or
 * "Save as PDF" (browser print; no PDF library). Built only from the run
 * record and the server-derived checks. It includes cited quotes but never
 * the document body (minimum necessary). The JSON audit package with its
 * digest stays the machine-verifiable export.
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { EvidenceCheck } from "./api";
import type { Run } from "../orchestrator/runTypes";
import { BOUNDARY, PACKET, STATUS_WORD, decisionWords, draftStatusWords } from "./copy";

const FIELD_WORDS: Record<string, string> = {
  therapy_start_date: "Therapy start date",
  therapy_end_date: "Therapy end date",
  documented_visit_count: "Documented visits",
  supervision_statement: "Supervision statement",
  discharge_outcome: "Discharge outcome",
};

export function EvidencePacket({ run, checks, generatedAt, onClose }: { run: Run; checks: EvidenceCheck[]; generatedAt: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    document.body.classList.add("packet-open");
    const d = ref.current;
    if (d && !d.open) d.showModal?.();
    closeRef.current?.focus();
    return () => document.body.classList.remove("packet-open");
  }, []);
  const n = (s: EvidenceCheck["status"]) => checks.filter((c) => c.status === s).length;
  const facts = run.extraction?.output && !run.extraction.output.abstain ? run.extraction.output.facts : [];
  const rb = run.execution.readback;
  return createPortal(
    <dialog ref={ref} className="packet" aria-labelledby="packet-h" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="packet-actions no-print">
        <button className="btn primary" onClick={() => window.print()}>{PACKET.print}</button>
        <button ref={closeRef} className="btn secondary" onClick={onClose}>{PACKET.close}</button>
      </div>
      <article className="packet-doc" data-testid="evidence-packet">
        <header>
          <p className="eyebrow">EvidenceBridge</p>
          <h2 id="packet-h">{PACKET.title}</h2>
          <dl className="packet-meta">
            <dt>Draft</dt><dd>{run.event.draftId} (version {run.event.draftVersion})</dd>
            <dt>Patient (synthetic)</dt><dd>{run.event.patientId}{run.context ? `, age ${run.context.patientAgeBand}` : ""}</dd>
            <dt>Service</dt><dd>{run.context?.serviceRequestDescription ?? "Not recorded"}</dd>
            <dt>Draft status now</dt><dd>{draftStatusWords(run.execution.stateChange?.to ?? run.context?.draft.businessStatus)}</dd>
            <dt>Generated</dt><dd>From check {run.runId}, checked {run.createdAt}, printed view made {generatedAt}</dd>
          </dl>
        </header>

        <section>
          <h3>Decision</h3>
          <p><strong>{decisionWords(run.policyResult?.decision ?? null)}</strong></p>
          {(run.policyResult?.reasons ?? []).length > 0 && <ul>{run.policyResult!.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        </section>

        <section>
          <h3>Checks</h3>
          <p className="packet-complete">Completeness: {n("PASS")} passed, {n("WARN")} need a person, {n("FAIL")} did not pass, {n("NOT_EVALUATED")} not checked. A check that did not run is listed as not checked, never as passed.</p>
          <table className="mini">
            <thead><tr><th>Check</th><th>Result</th><th>What it found</th></tr></thead>
            <tbody>{checks.map((c) => <tr key={c.checkId}><td>{c.label}</td><td>{STATUS_WORD[c.status]}</td><td>{c.detail}</td></tr>)}</tbody>
          </table>
        </section>

        <section>
          <h3>Cited facts</h3>
          {facts.length === 0 ? <p>No facts were extracted for this check.</p> : (
            <table className="mini">
              <thead><tr><th>Fact</th><th>Value</th><th>Exact quote from the document</th><th>Where</th></tr></thead>
              <tbody>{facts.map((f) => <tr key={f.field}><td>{FIELD_WORDS[f.field] ?? f.field}</td><td>{String(f.normalizedValue)}</td><td>“{f.quote}”</td><td>Page {f.sourcePage}, characters {f.sourceStart}–{f.sourceEnd}</td></tr>)}</tbody>
            </table>
          )}
          {run.document && <p className="hint">Source: {run.document.title}, dated {run.document.date}. Only the quoted lines are reproduced here.</p>}
        </section>

        <section>
          <h3>Saved task, read back</h3>
          {!rb ? <p>No task has been written for this check, so there is nothing to read back.</p> : (
            <>
              <p>{rb.verified ? `Verified: ${rb.checks.filter((c) => c.pass).length} of ${rb.checks.length} fields matched.` : `Not verified: ${rb.checks.filter((c) => !c.pass).length} field(s) did not match.`}</p>
              <table className="mini">
                <thead><tr><th>Field</th><th>Expected</th><th>Read back</th><th>Match</th></tr></thead>
                <tbody>{rb.checks.map((c) => <tr key={c.name}><td>{c.name}</td><td>{c.expected}</td><td>{c.actual}</td><td>{c.pass ? "Yes" : "No"}</td></tr>)}</tbody>
              </table>
            </>
          )}
        </section>

        <footer>
          <p>{BOUNDARY.synthetic} · {BOUNDARY.noChart} · {BOUNDARY.noPayer}</p>
          <p>{PACKET.honesty}</p>
        </footer>
      </article>
    </dialog>,
    document.body,
  );
}
