/**
 * Product P4 (spec CH-1.1, CH-2.1): Layer 1, "Why this decision". Collapsed by
 * default, remembered per browser, deep-linkable with #why. Renders only the
 * mapper output (server checks + policy reasons).
 */
import { useEffect, useState } from "react";
import type { EvidenceCheck } from "./api";
import type { Run } from "../orchestrator/runTypes";
import { STATUS_WORD, WHY } from "./copy";
import { whyView } from "./why";

const KEY = "eb.disclosure.v1";
const readOpen = (id: string): boolean => {
  try {
    if (window.location.hash === `#${id}`) return true;
    return (JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Record<string, boolean>)[id] === true;
  } catch { return false; }
};
const writeOpen = (id: string, open: boolean) => {
  try {
    const cur = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Record<string, boolean>;
    window.localStorage.setItem(KEY, JSON.stringify({ ...cur, [id]: open }));
  } catch { /* storage unavailable: disclosure still works for this view */ }
};

export function WhyPanel({ run, checks }: { run: Run; checks: EvidenceCheck[] }) {
  const [open, setOpen] = useState(() => readOpen("why"));
  useEffect(() => { writeOpen("why", open); }, [open]);
  // "See why" links to #why: open the panel when the hash points at it.
  useEffect(() => {
    const on = () => { if (window.location.hash === "#why") setOpen(true); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const v = whyView(run, checks);
  return (
    <details id="why" className="layer why" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary><span className="layer-title">{WHY.summary}</span><span className="muted"> · {WHY.hint}</span></summary>
      {!v ? <p>{WHY.noRun}</p> : (
        <div className="why-body">
          <section className="why-decision">
            <h3>{WHY.decided}</h3>
            <p className="why-decision-text">{v.decision}</p>
            {v.reasons.length > 0 && <ul>{v.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
          </section>
          <ol className="why-steps">
            {v.blocks.map((b) => (
              <li key={b.id} className={`why-step ${b.status.toLowerCase()}`}>
                <span className="why-q">{b.question}</span>
                <span className={`why-status check-${b.status.toLowerCase()}`}>{STATUS_WORD[b.status]}</span>
                <span className="why-a">{b.answer}</span>
              </li>
            ))}
          </ol>
          <section className="why-roles" aria-labelledby="why-roles-h">
            <h3 id="why-roles-h">{WHY.roles}</h3>
            <dl>
              <dt>Reader</dt><dd>{WHY.roleAgent}</dd>
              <dt>Rules</dt><dd>{WHY.roleRules}</dd>
              <dt>Task tool</dt><dd>{WHY.roleTool}</dd>
            </dl>
          </section>
        </div>
      )}
    </details>
  );
}
