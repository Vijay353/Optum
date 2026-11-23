/**
 * Product P9 (spec CH-3.1, CH-3.3): honest metrics. Observed tiles show the
 * server aggregate of real check records and say exactly how each is counted.
 * The one estimate is styled differently, shows its formula and uses an
 * editable assumption kept only in this browser.
 */
import { useEffect, useState } from "react";
import { apiClient, type Metrics as M } from "./api";
import { METRICS } from "./copy";
import { DEFAULT_MINUTES_PER_CHASE, decisionBars, readbackRate, snapshotText, staffTimeEstimate } from "./metricsText";
import { ErrorNote, Skeleton } from "./states";

const MIN_KEY = "eb.metrics.minutesPerChase.v1";
const readMinutes = (): number => {
  try {
    const v = Number(window.localStorage.getItem(MIN_KEY));
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_MINUTES_PER_CHASE;
  } catch { return DEFAULT_MINUTES_PER_CHASE; }
};

function Tile({ value, label, how }: { value: string; label: string; how: string }) {
  return (
    <article className="tile">
      <p className="tile-value">{value}</p>
      <p className="tile-label">{label}</p>
      <details className="tile-how"><summary>How is this counted?</summary><p>{how}</p></details>
    </article>
  );
}

export function Metrics() {
  const [data, setData] = useState<{ metrics: M; computedAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minutes, setMinutes] = useState<number>(readMinutes);
  const [copied, setCopied] = useState<string | null>(null);
  const load = () => { setError(null); apiClient.metrics().then(setData).catch((e: Error) => setError(e.message)); };
  useEffect(load, []);
  useEffect(() => { try { window.localStorage.setItem(MIN_KEY, String(minutes)); } catch { /* not persisted */ } }, [minutes]);

  if (error) return <ErrorNote what="The numbers could not be loaded." detail={error} onRetry={load} />;
  if (!data) return <Skeleton lines={6} label="Counting check records" />;
  const m = data.metrics;
  const e = staffTimeEstimate(m, minutes);
  const rate = readbackRate(m);
  const bars = decisionBars(m);
  const copy = async () => {
    const text = snapshotText(m, data.computedAt, minutes);
    try { await navigator.clipboard.writeText(text); setCopied("Copied. Paste it into your notes or deck."); }
    catch { setCopied(text); }
  };

  return (
    <div className="page metrics">
      <header className="page-head">
        <h1>{METRICS.heading}</h1>
        <p className="meta">{METRICS.sub} Counted at {data.computedAt}.</p>
      </header>
      {m.checksRun === 0 ? <p className="empty-note">{METRICS.empty}</p> : (
        <>
          <section className="tiles" aria-label="Observed counts">
            <Tile value={String(m.draftsChecked)} label="Drafts checked before submission" how="Distinct drafts with at least one evidence check in the run records." />
            <Tile value={String(m.evidenceFoundDrafts)} label="Drafts with outside evidence found" how="Drafts whose latest check found usable outside evidence (waiting to stage or staged)." />
            <Tile value={String(m.tasksStaged)} label="Review tasks created and verified" how="Distinct task ids on checks that finished as staged and verified. A replayed request is counted once." />
            <Tile value={rate === null ? "—" : `${rate}%`} label={rate === null ? "Read-back: no writes yet" : `Read-back matched (${m.readback.verified} of ${m.readback.attempted})`} how="Every write is read back from the record system field by field. This is the share where every field matched." />
            <Tile value={String(m.writesRefused)} label="Writes refused by safety checks" how="Staging attempts stopped by the final permission/age check or a version change. Nothing was written for these." />
            <Tile value={String(m.checksRun)} label="Checks run in total" how="Every check, including repeats and redelivered events." />
          </section>

          <section className="panel" aria-labelledby="dist-h">
            <h2 id="dist-h">Latest result for each draft</h2>
            <figure className="dist" aria-label={bars.map((b) => `${b.label} ${b.value}`).join(", ")}>
              {bars.map((b) => (
                <div className="bar-row wide" key={b.key}>
                  <span className="bar-label">{b.label}</span>
                  <span className="bar-track" aria-hidden="true"><span className="bar-fill documented" style={{ width: `${b.widthPct}%` }} /></span>
                  <span className="bar-value">{b.value}</span>
                </div>
              ))}
            </figure>
            <p className="hint">Average steps recorded per check: {Object.entries(m.avgTraceSteps).map(([k, v]) => `${bars.find((b) => b.key === k)?.label ?? k} ${v}`).join(" · ")}.</p>
          </section>

          <section className="panel estimate" aria-labelledby="est-h">
            <p className="estimate-tag">{METRICS.estimateLabel}</p>
            <h2 id="est-h">{METRICS.estimateTitle}</h2>
            <p className="tile-value">about {e.hoursSaved} h</p>
            <p><strong>Formula:</strong> {e.formula}.</p>
            <label className="field">
              <span>{METRICS.minutesLabel}</span>
              <input type="number" min={1} max={600} inputMode="numeric" value={minutes} onChange={(ev) => setMinutes(Number(ev.target.value) || DEFAULT_MINUTES_PER_CHASE)} />
            </label>
            <p className="hint">This is not a measurement. It assumes each draft where outside evidence was found would otherwise need one manual records chase. Replace {DEFAULT_MINUTES_PER_CHASE} minutes with your own time study.</p>
          </section>

          <section className="panel" aria-labelledby="snap-h">
            <h2 id="snap-h">Snapshot for your notes or deck</h2>
            <p className="hint">Plain text, built only from the numbers above, with the estimate labelled as an estimate.</p>
            <div className="row"><button className="btn secondary" onClick={copy}>Copy summary</button></div>
            {copied && (copied.includes("\n") ? <pre className="snapshot" aria-label="Summary text">{copied}</pre> : <p role="status">{copied}</p>)}
          </section>
        </>
      )}
    </div>
  );
}
