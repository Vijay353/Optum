/**
 * Product P6 (spec CH-1.5): the simulation is a lab instrument, not the
 * product. Scenario loading and the failure drills live here, visibly marked
 * as demo-only, and are hidden entirely in pitch mode. Every control calls an
 * existing route; nothing new can write.
 */
import type { ClockState, Scenario } from "./api";

export function DemoLab({ scenarios, selected, onSelect, activeId, clock, busy, canLoad, canDrill, onLoad, onRedeliver, onEdit, onAdvance, fmt }: {
  scenarios: Scenario[];
  selected: string;
  onSelect: (id: string) => void;
  activeId: string | null;
  clock: ClockState;
  busy: string | null;
  canLoad: boolean;
  canDrill: boolean;
  onLoad: () => void;
  onRedeliver: () => void;
  onEdit: () => void;
  onAdvance: () => void;
  fmt: (iso: string) => string;
}) {
  const active = scenarios.find((s) => s.id === activeId);
  const chosen = scenarios.find((s) => s.id === selected);
  return (
    <section className="demo-lab" aria-label="Demo scenario">
      <div className="demo-lab-bar">
        <span className="demo-tag">Demo Lab</span>
        <span>Scenario: <strong>{active ? `${active.order}. ${active.title}` : "none loaded"}</strong></span>
        <span className="clock-line">
          {clock.mode === "scenario" ? "Scenario time" : "System time"}: <strong>{fmt(clock.now)}</strong>
          {clock.mode === "scenario" && (clock.offsetMs > 0 ? ` (moved forward ${Math.round(clock.offsetMs / 3600_000)} h for the demo)` : " (fixed start for this scenario)")}
        </span>
      </div>
      <details className="demo-drawer">
        <summary>Open the lab: scenarios and demo controls (failure and recovery drills)</summary>
        <div className="demo-body">
          <div className="scenario-pick">
            <label htmlFor="scenario">Synthetic scenario</label>
            <div className="row">
              <select id="scenario" value={selected} onChange={(e) => onSelect(e.target.value)}>
                {scenarios.map((s) => <option key={s.id} value={s.id}>{s.order}. {s.title}</option>)}
              </select>
              <button className="btn secondary" disabled={!!busy || !canLoad} onClick={onLoad}>{busy === "load" ? "Resetting…" : "Load & reset"}</button>
            </div>
            <p className="hint">{chosen?.description} Loading resets all simulators to fixed synthetic data.</p>
          </div>
          <div className="demo-grid">
            <div>
              <button className="btn secondary" disabled={!canDrill || !!busy} onClick={onRedeliver}>Redeliver the same event</button>
              <p className="hint">Sends the same event again. Staging again returns the task already made instead of a second one.</p>
            </div>
            <div>
              <button className="btn secondary" disabled={!canDrill || !!busy} onClick={onEdit}>Simulate another user editing the draft</button>
              <p className="hint">Changes the draft version. A task staged for the old version is then refused.</p>
            </div>
            <div>
              <button className="btn secondary" disabled={!canDrill || !!busy} onClick={onAdvance}>Move scenario time forward 25 hours</button>
              <p className="hint">The check is then older than the 24-hour limit, so staging is refused until the check is run again.</p>
            </div>
          </div>
        </div>
      </details>
    </section>
  );
}
