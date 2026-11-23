/**
 * Product P10 (spec CH-3.2): guided tour for pitch mode. Captions only; each
 * step is ticked from real recorded state, so a failure shows as a failure.
 * The one button it owns (start fresh) calls the existing scenario route.
 */
import type { TourStep } from "./pitch";

export function GuidedTour({ steps, onStartFresh, onHide, busy, error }: { steps: TourStep[]; onStartFresh: () => void; onHide: () => void; busy: boolean; error: string | null }) {
  const current = steps.find((s) => !s.done);
  return (
    <section className="tour" aria-labelledby="tour-h">
      <div className="tour-head">
        <h2 id="tour-h">Guided tour</h2>
        <button className="btn link" onClick={onHide}>Hide the tour</button>
      </div>
      <ol className="tour-steps">
        {steps.map((s, i) => (
          <li key={s.id} className={s.done ? "done" : s === current ? "current" : ""} aria-current={s === current ? "step" : undefined}>
            <span className="tour-num" aria-hidden="true">{s.done ? "✓" : i + 1}</span>
            <span><strong>{s.title}</strong><span className="sr-only"> ({s.done ? "done" : s === current ? "current step" : "not started"})</span><br />{s.body}</span>
          </li>
        ))}
      </ol>
      <div className="row">
        <button className="btn secondary" disabled={busy} onClick={onStartFresh}>Start fresh with the demo case</button>
        {!current && <span role="status">Tour complete. Everything shown came from real checks on this server.</span>}
      </div>
      {error && <p className="alert bad" role="alert">The tour step failed: {error}. Nothing was faked; fix the cause or continue by hand.</p>}
    </section>
  );
}
