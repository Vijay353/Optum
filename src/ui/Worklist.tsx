/**
 * Product P3 (spec CH-1.2): the queue of drafts, grouped by what each needs.
 * Status is always in words (never colour alone). Selecting a row only
 * changes what is shown. "Check all" runs the existing read-only check per
 * draft, one after another, and never stages anything.
 */
import { useEffect, useState } from "react";
import type { WorklistItem } from "./api";
import { GROUP_LABEL, GROUP_ORDER, queueStatus, sortQueue, uncheckedDrafts } from "./worklist";
import { QUEUE, draftStatusWords } from "./copy";
import { EmptyState, Skeleton } from "./states";

export function Worklist({ items, selected, onSelect, onCheckAll, progress, canCheck, busy, error }: {
  items: WorklistItem[] | null;
  selected: string | null;
  onSelect: (draftId: string) => void;
  onCheckAll: () => void;
  progress: { done: number; total: number } | null;
  canCheck: boolean;
  busy: boolean;
  error: string | null;
}) {
  const sorted = items ? sortQueue(items) : [];
  const waiting = items ? uncheckedDrafts(items).length : 0;
  const narrow = useNarrow();
  const current = sorted.find((i) => i.draftId === selected);
  return (
    <nav className="worklist" aria-labelledby="worklist-h">
      <div className="worklist-head">
        <h2 id="worklist-h">{QUEUE.heading}</h2>
        {items && <span className="count-pill" aria-live="polite">{items.length} draft{items.length === 1 ? "" : "s"}</span>}
      </div>
      {items && items.length > 0 && (
        <div className="check-all">
          <button className="btn secondary wide" disabled={busy || !canCheck || waiting === 0} onClick={onCheckAll} aria-describedby="check-all-help">
            {progress ? QUEUE.checkAllBusy(Math.min(progress.done + 1, progress.total), progress.total) : waiting > 0 ? QUEUE.checkAll(waiting) : QUEUE.checkAllNone}
          </button>
          <p id="check-all-help" className="hint">{QUEUE.checkAllHelp}</p>
        </div>
      )}
      {error && <p className="alert bad" role="alert">{QUEUE.loadError}</p>}
      {!items && !error && <Skeleton lines={5} label="Loading drafts" />}
      {items && items.length === 0 && <EmptyState>{QUEUE.empty}</EmptyState>}
      {/* Spec CH-4.2: on narrow screens the queue folds away so the selected draft's next step is on the first screen. */}
      <QueueFold narrow={narrow} summary={`Show all drafts (${sorted.length})${current ? ` · now: ${current.draftId.replace(/^PA-DRAFT-/, "Draft ")}, ${queueStatus(current).label}` : ""}`}>
      {GROUP_ORDER.map((g) => {
        const rows = sorted.filter((i) => queueStatus(i).group === g);
        if (!rows.length) return null;
        return (
          <section key={g} className="queue-group" aria-label={`${GROUP_LABEL[g]}: ${rows.length}`}>
            <h3 className="queue-group-h">{GROUP_LABEL[g]} <span className="muted">({rows.length})</span></h3>
            <ul className="queue-list">
              {rows.map((i) => {
                const st = queueStatus(i);
                const active = i.draftId === selected;
                return (
                  <li key={i.draftId}>
                    <button
                      className={`queue-row ${active ? "active" : ""}`}
                      aria-current={active ? "true" : undefined}
                      onClick={() => onSelect(i.draftId)}
                      data-testid={`queue-${i.draftId}`}
                    >
                      <span className="queue-row-top">
                        <span className="queue-id">{i.draftId.replace(/^PA-DRAFT-/, "Draft ")}</span>
                        <span className={`queue-status ${st.tone}`}>{st.label}</span>
                      </span>
                      <span className="queue-sub">Patient {i.patientId.replace(/^SYN-PAT-/, "")}{i.ageBand ? ` · age ${i.ageBand}` : ""}{st.hint ? ` · ${st.hint}` : ""}</span>
                      <span className="sr-only">. Draft status: {draftStatusWords(i.businessStatus)}.</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      </QueueFold>
    </nav>
  );
}

function useNarrow(): boolean {
  const q = "(max-width: 860px)";
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

function QueueFold({ narrow, summary, children }: { narrow: boolean; summary: string; children: React.ReactNode }) {
  if (!narrow) return <>{children}</>;
  return (
    <details className="queue-fold">
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
