import { useState } from "react";
import type { ReactNode } from "react";
import type { Run } from "../orchestrator/runTypes";
import { apiClient, type TaskRes } from "./api";
import { track } from "./analytics";
import { claimsEmptyText, readbackEmptyText } from "./emptyStates";

/** Collapsed-by-default inspector. Everything shown comes from the persisted run record or the simulators. */
export function TechnicalInspector({ run, tasks, faults }: { run: Run; tasks: TaskRes[]; faults: Record<string, unknown> }) {
  const [audit, setAudit] = useState<{ app: unknown[]; ehr: unknown[] } | null>(null);
  return (
    <details className="inspector" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !audit) apiClient.audit(run.runId).then(setAudit).catch(() => undefined); }}>
      <summary>
        <span>› Technical evidence</span>
        <span className="muted">FHIR resources · access decision · citations · hashes · policy · tool result · audit</span>
      </summary>
      <div className="inspector-body">
        <Section title="Audit evidence package">
          <ExportPackage runId={run.runId} />
        </Section>
        <Section title={`Execution trace · ${run.runId} · ${run.status}`}>
          <table className="mini trace">
            <thead><tr><th>#</th><th>Step</th><th>Actor</th><th>Result</th><th>Summary</th><th>HTTP calls (real)</th><th>ms</th></tr></thead>
            <tbody>
              {run.trace.map((s) => (
                <tr key={s.seq}>
                  <td>{s.seq}</td>
                  <td><code>{s.step}</code></td>
                  <td>{s.actor}</td>
                  <td className={s.ok ? "good" : "bad"}>{s.ok ? "ok" : "fail"}</td>
                  <td>{s.summary}</td>
                  <td>{s.calls.map((c, i) => <div key={i}><code>{c.method} {c.path}</code> → {c.status ?? c.outcome}{c.attempt > 1 ? ` (attempt ${c.attempt})` : ""}</div>)}</td>
                  <td>{s.durationMs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        <Section title="Event"><Json value={run.event} /></Section>
        <Section title="Source versions"><Json value={{ draft: run.context?.draft, policy: run.context?.policy, localDocuments: run.context?.localDocuments }} /></Section>
        <Section title="Provider Access authorization"><Json value={run.access} /></Section>
        <Section title="Claim leads (ExplanationOfBenefit — leads only)">
          {run.claims?.leads.length ? (
            <table className="mini"><thead><tr><th>EOB</th><th>Service date</th><th>Provider</th><th>Code</th><th>Outcome</th></tr></thead>
              <tbody>{run.claims.leads.map((l) => <tr key={l.id}><td>{l.id}</td><td>{l.serviceDate}</td><td>{l.providerOrgId}</td><td>{l.code} · {l.codeDisplay}</td><td>{l.outcome}</td></tr>)}</tbody></table>
          ) : <p className="muted">{claimsEmptyText(run)}</p>}
        </Section>
        <Section title="External document, hash and patient match">
          <Json value={{ document: run.document, candidates: run.candidates ?? null, patientMatch: run.patientMatch, lookback: run.lookback }} />
        </Section>
        <Section title="Extraction (agent output, validated)">
          <Json value={run.extraction} />
        </Section>
        <Section title={`Policy input → result (${run.policyResult?.policyVersion ?? "not evaluated"})`}><Json value={{ input: run.policyInput, result: run.policyResult }} /></Section>
        <Section title="Tool payload → result"><Json value={{ stagedToolInput: run.stagedToolInput, result: run.execution.result, error: run.execution.error, toolCalls: run.execution.toolCalls }} /></Section>
        <Section title="Read-after-write verification">
          {run.execution.readback ? (
            <table className="mini"><thead><tr><th>Check</th><th>Expected</th><th>Read back</th><th></th></tr></thead>
              <tbody>{run.execution.readback.checks.map((c) => <tr key={c.name}><td>{c.name}</td><td><code>{c.expected}</code></td><td><code>{c.actual}</code></td><td className={c.pass ? "good" : "bad"}>{c.pass ? "pass" : "FAIL"}</td></tr>)}</tbody></table>
          ) : <p className="muted">{readbackEmptyText(run)}</p>}
        </Section>
        <Section title="Tasks currently stored in the mock EHR for this draft"><Json value={tasks} /></Section>
        <Section title="Active simulator faults"><Json value={faults} /></Section>
        <Section title="Audit (orchestrator + EHR, append-only, hash-chained)">
          <AuditVerify />
          {audit ? <Json value={audit} /> : <p className="muted">Loading…</p>}
        </Section>
      </div>
    </details>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="insp-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

/** CH-17: runs the server-side chain verification and shows coverage and limits. */
function AuditVerify() {
  const [r, setR] = useState<Awaited<ReturnType<typeof apiClient.verifyAudit>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const words: Record<string, ReactNode> = { OK: "verified", TAMPERED: "CHANGE DETECTED", NO_ROWS: "no rows yet", UNVERIFIABLE: "not verifiable (written before hashing)" };
  return (
    <div className="audit-verify">
      <button className="btn secondary" onClick={() => apiClient.verifyAudit().then(setR, (e: Error) => setErr(e.message))}>Verify audit chain</button>
      {err && <p className="bad">{err}</p>}
      {r && (
        <ul aria-live="polite">
          {r.tables.map((t) => (
            <li key={t.table} className={t.status === "TAMPERED" ? "bad" : t.status === "OK" ? "good" : ""}>
              <code>{t.table}</code>: {words[t.status] ?? t.status}. {t.reason}
            </li>
          ))}
          <li className="muted">{r.algorithm}. {r.limits}</li>
        </ul>
      )}
    </div>
  );
}

/** CH-18: export one run's evidence as JSON. Shows the real evidence status, never a blanket green badge. */
function ExportPackage({ runId }: { runId: string }) {
  const [r, setR] = useState<{ status: string; missing: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setErr(null);
    track("audit_export_clicked");
    try {
      const p = await apiClient.evidencePackage(runId);
      setR({ status: p.status, missing: p.missing });
      const url = URL.createObjectURL(new Blob([p.text], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = p.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const words: Record<string, string> = { complete: "Complete", partial: "Partial", unverifiable: "Unverifiable" };
  return (
    <div className="audit-verify">
      <button className="btn secondary" onClick={run}>Export audit evidence package (JSON)</button>
      <p className="muted">Includes the decision, checks, write, read-back, trace and audit rows with chain hashes. No document text. The digest is a checksum, not a signature.</p>
      {err && <p className="bad" role="alert">{err}</p>}
      {r && (
        <p role="status">
          Evidence status: <strong className={r.status === "complete" ? "good" : "bad"}>{words[r.status] ?? r.status}</strong>
          {r.missing.length > 0 && <> · Missing: {r.missing.join(" ")}</>}
        </p>
      )}
    </div>
  );
}
