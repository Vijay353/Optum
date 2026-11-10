import { useCallback, useEffect, useState } from "react";
import { ApiError, apiClient, setImportMode, type ImportBatch, type ImportCommitResult, type ImportPreview, type Role } from "./api";
import { recordsEmptyText } from "./emptyStates";

const ENTITIES = [
  "prior_auth_drafts", "patients", "coverage", "service_requests", "provider_attribution", "patient_opt_out",
  "explanation_of_benefits", "document_references", "document_contents", "policy_requirements", "tasks", "ehr_audit",
];
const CSV_ENTITIES = ENTITIES.filter((e) => e !== "tasks" && e !== "ehr_audit");

/** Secondary surface: simulator setup through validated XLSX/CSV interchange. */
export function DataStudio({ role }: { role: Role }) {
  const canWrite = role !== "viewer";
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [commit, setCommit] = useState<ImportCommitResult | null>(null);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [entity, setEntity] = useState("prior_auth_drafts");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRecords = useCallback(async () => {
    const r = await apiClient.records(entity, q);
    setRows(r.rows);
    setTotal(r.total);
  }, [entity, q]);
  const loadBatches = useCallback(async () => setBatches((await apiClient.imports()).batches), []);

  useEffect(() => { loadRecords().catch((e: Error) => setError(e.message)); }, [loadRecords]);
  useEffect(() => { loadBatches().catch(() => undefined); }, [loadBatches]);

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try { await fn(); } catch (e) { setError(e instanceof ApiError ? e.message : (e as Error).message); } finally {
      setBusy(null);
      await Promise.all([loadRecords(), loadBatches()]).catch(() => undefined);
    }
  };

  const changes = preview ? Object.values(preview.diff).reduce((n, d) => n + d.added + d.updated + d.removed, 0) : 0;
  const columns = rows[0] ? Object.keys(rows[0]) : [];

  return (
    <div className="page">
      <section className="header-row">
        <div>
          <h1>Data Studio · simulator setup</h1>
          <p className="meta">Edit synthetic records in Excel, preview every change, then commit them atomically into the mock EHR, Provider Access, HIE and policy simulators. Excel is an interchange format — not a system of record.</p>
        </div>
      </section>
      {error && <div className="alert bad" role="alert">{error}</div>}

      <div className="studio-grid">
        <section className="panel" aria-labelledby="imp-h">
          <h2 id="imp-h">1 · Import a workbook</h2>
          <p className="muted">Start from the <a href="/api/data/template.xlsx">sample workbook (.xlsx)</a> — it has a README sheet with every column, type and allowed value. CSV works per entity (file named <code>&lt;entity&gt;.csv</code>, merge mode).</p>
          <div className="row">
            <input type="file" accept=".xlsx,.csv" aria-label="Workbook file" disabled={!canWrite} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setCommit(null); }} />
          </div>
          <fieldset className="row" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="muted" style={{ fontSize: 12 }}>Mode</legend>
            <label><input type="radio" name="mode" checked={mode === "merge"} onChange={() => setMode("merge")} /> Merge (upsert by key)</label>
            <label><input type="radio" name="mode" checked={mode === "replace"} onChange={() => setMode("replace")} /> Replace everything (clears tasks and runs)</label>
          </fieldset>
          <div className="row">
            <button className="btn secondary" disabled={!file || !canWrite || !!busy} onClick={() => act("preview", async () => { setImportMode(mode); setCommit(null); setPreview(await apiClient.importPreview(file!)); })}>
              {busy === "preview" ? "Validating…" : "Validate & preview"}
            </button>
            {!canWrite && <span className="hint">Read-only viewers cannot import.</span>}
          </div>

          {preview && (
            <div aria-live="polite">
              <p><strong>{preview.filename}</strong> · {preview.mode} · schema {preview.schemaVersion ?? "unknown"} · {preview.issues.length} issue(s)</p>
              {Object.keys(preview.diff).length > 0 && (
                <table className="mini diff-table">
                  <thead><tr><th>Sheet</th><th className="num">Added</th><th className="num">Updated</th><th className="num">Unchanged</th><th className="num">Rejected</th><th className="num">Removed</th></tr></thead>
                  <tbody>{Object.entries(preview.diff).map(([k, d]) => (
                    <tr key={k}><td>{k}</td><td className="num">{d.added}</td><td className="num">{d.updated}</td><td className="num">{d.unchanged}</td><td className={`num ${d.rejected ? "bad" : ""}`}>{d.rejected}</td><td className="num">{d.removed}</td></tr>
                  ))}</tbody>
                </table>
              )}
              {preview.issues.length > 0 && (
                <ul className="issue-list">
                  {preview.issues.map((i, n) => <li key={n}><strong>{i.sheet}</strong>{i.row !== null ? ` row ${i.row}` : ""}{i.column ? ` · ${i.column}` : ""}: {i.message}</li>)}
                </ul>
              )}
              {preview.canCommit ? (
                <div className="row">
                  <button className="btn primary" disabled={!!busy} onClick={() => act("commit", async () => { setCommit(await apiClient.importCommit(preview.batchId!)); setPreview(null); })}>
                    {busy === "commit" ? "Committing…" : `Commit ${changes} change(s)${preview.issues.length ? " — rejected rows are skipped" : ""}`}
                  </button>
                </div>
              ) : (
                <p className="warn-text">{changes === 0 && !preview.issues.length ? "No changes — the simulators already hold this data (idempotent re-import)." : "This file cannot be committed. Fix the issues above and preview again."}</p>
              )}
            </div>
          )}
          {commit && (
            <div className="note ok" role="status">
              <p className="note-title">COMMITTED {commit.batchId}</p>
              <p>Re-query verification: {commit.verified ? "every committed row was read back unchanged" : "MISMATCH — check the import history"}.</p>
            </div>
          )}
        </section>

        <section className="panel" aria-labelledby="exp-h">
          <h2 id="exp-h">2 · Export, reset and history</h2>
          <div className="row">
            <a className="btn secondary" href="/api/data/export.xlsx">Export snapshot (.xlsx)</a>
            <select aria-label="CSV entity" id="csv-entity" defaultValue="prior_auth_drafts">
              {CSV_ENTITIES.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
            <button className="btn secondary" onClick={() => { const e = (document.getElementById("csv-entity") as HTMLSelectElement).value; window.location.href = `/api/data/export/${e}.csv`; }}>Export CSV</button>
          </div>
          <p className="hint">Exports include the read-only tasks sheet. Cells starting with = + − @ are prefixed with ' to prevent spreadsheet formula injection.</p>
          <div className="row">
            <button className="btn secondary" disabled={!canWrite || !!busy} onClick={() => act("reset", async () => { await apiClient.loadScenario("primary-success"); })}>
              {busy === "reset" ? "Resetting…" : "Reset sample dataset"}
            </button>
          </div>
          <h3 style={{ fontSize: 14 }}>Import history</h3>
          {batches.length === 0 ? <p className="muted">No imports yet. Imports you preview or commit are listed here.</p> : (
            <table className="mini">
              <thead><tr><th>Batch</th><th>When</th><th>File</th><th>Mode</th><th>Status</th><th></th></tr></thead>
              <tbody>{batches.map((b) => (
                <tr key={b.id}>
                  <td><code>{b.id}</code></td><td>{new Date(b.at).toLocaleString()}</td><td>{b.filename}</td><td>{b.mode}</td><td>{b.status}</td>
                  <td>{(b.status === "COMMITTED" || b.status === "COMMITTED_UNVERIFIED") && canWrite && (
                    <button className="btn link" disabled={!!busy} onClick={() => { if (window.confirm("Restore the simulators to the state before this import? Tasks and runs are cleared.")) act("restore", async () => { await apiClient.restore(b.id); }); }}>Restore before</button>
                  )}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </section>
      </div>

      <section className="panel" aria-labelledby="rec-h">
        <h2 id="rec-h">3 · Browse simulator records</h2>
        <div className="records-toolbar">
          <select aria-label="Entity" value={entity} onChange={(e) => setEntity(e.target.value)}>
            {ENTITIES.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
          <input type="search" placeholder="Search…" aria-label="Search records" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn secondary" onClick={() => act("refresh", async () => undefined)}>Refresh</button>
          <span className="muted" style={{ alignSelf: "center" }}>{rows.length} of {total} shown · live from simulator storage</span>
        </div>
        <div className="records-wrap">
          <table className="mini">
            <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}>{columns.map((c) => <td key={c}>{fmt(r[c])}</td>)}</tr>)}</tbody>
          </table>
          {rows.length === 0 && (
            <p className="muted empty-state">
              {recordsEmptyText(entity, total, q)}
              {q && total > 0 && <> <button className="btn link" onClick={() => setQ("")}>Clear the search</button></>}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
