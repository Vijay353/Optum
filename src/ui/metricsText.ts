/**
 * Product P9 (spec CH-3.1, CH-3.3): metric presentation helpers. Pure.
 * Observed numbers come only from the server aggregate; the estimate is a
 * visible formula over an observed count and an editable assumption.
 */
import type { Metrics } from "../server/metrics";
import { DECISION_SHORT } from "./copy";

export const DEFAULT_MINUTES_PER_CHASE = 35;

export type Estimate = { draftsWithEvidence: number; minutesPerChase: number; minutesSaved: number; hoursSaved: number; formula: string };

export function staffTimeEstimate(m: Metrics, minutesPerChase: number): Estimate {
  const minutes = Number.isFinite(minutesPerChase) && minutesPerChase >= 0 ? Math.min(minutesPerChase, 600) : DEFAULT_MINUTES_PER_CHASE;
  const saved = m.evidenceFoundDrafts * minutes;
  return {
    draftsWithEvidence: m.evidenceFoundDrafts,
    minutesPerChase: minutes,
    minutesSaved: saved,
    hoursSaved: Math.round((saved / 60) * 10) / 10,
    formula: `${m.evidenceFoundDrafts} draft${m.evidenceFoundDrafts === 1 ? "" : "s"} with outside evidence found × ${minutes} min per manual records chase = ${saved} min`,
  };
}

export const readbackRate = (m: Metrics): number | null => (m.readback.attempted ? Math.round((m.readback.verified / m.readback.attempted) * 100) : null);

/** Decision bars, largest first, with plain labels. */
export function decisionBars(m: Metrics): Array<{ key: string; label: string; value: number; widthPct: number }> {
  const entries = Object.entries(m.latestDecisions).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return entries.map(([k, v]) => ({ key: k, label: DECISION_SHORT[k] ?? k, value: v, widthPct: Math.round((v / max) * 100) }));
}

/** CH-3.3: a fact sheet built only from computed values, with the honesty footer. */
export function snapshotText(m: Metrics, computedAt: string, minutesPerChase: number): string {
  const e = staffTimeEstimate(m, minutesPerChase);
  const rate = readbackRate(m);
  const lines = [
    "EvidenceBridge snapshot (computed from this server's check records)",
    `As of: ${computedAt}`,
    `Drafts checked before submission: ${m.draftsChecked} (${m.checksRun} checks in total)`,
    ...decisionBars(m).map((b) => `  ${b.label}: ${b.value}`),
    `Review tasks created and verified: ${m.tasksStaged}`,
    `Read-back verification: ${rate === null ? "no writes yet" : `${m.readback.verified} of ${m.readback.attempted} (${rate}%)`}`,
    `Writes refused by safety checks: ${m.writesRefused}`,
    `ESTIMATE, not observed: ${e.formula} (about ${e.hoursSaved} h). The minutes per chase is an assumption.`,
    "Conceptual prototype, simulated data, demo identity. Not an official Optum product.",
  ];
  return lines.join("\n");
}
