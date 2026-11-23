/**
 * Product P5 (spec CH-1.3): confirmation before the only write. A native
 * modal <dialog> (focus stays inside, Escape cancels, focus returns to the
 * Stage button). It restates the staged tool input in words and then calls
 * the existing stage route; it decides and caches nothing.
 */
import { useEffect, useRef } from "react";
import type { StagingProjection } from "./projection";
import { CONFIRM, draftStatusWords } from "./copy";

export function ConfirmSheet({ p, onConfirm, onCancel, fmt }: { p: StagingProjection | null; onConfirm: () => void; onCancel: () => void; fmt: (iso: string) => string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<Element | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    returnTo.current = document.activeElement;
    const d = ref.current;
    if (d && !d.open) d.showModal?.();
    // showModal() focuses the first control (Cancel); the safe default for Enter is the explicit confirm.
    confirmRef.current?.focus();
    return () => { (returnTo.current as HTMLElement | null)?.focus?.(); };
  }, []);
  const will = p
    ? [
        p.taskEffect === "CREATE" ? `Create 1 review task for the ${p.owner}` : `Create 1 review task for the ${p.owner}, or return the one already created (no duplicate)`,
        `Set the review due date to ${fmt(p.dueAt)}`,
        `Change draft ${p.draftId} from “${draftStatusWords(p.fromStatus)}” to “${draftStatusWords(p.toStatus)}”`,
        `Link the task to the cited document and ${p.claimLeadCount} claim line${p.claimLeadCount === 1 ? "" : "s"}`,
      ]
    : ["Create 1 review task for the PA specialist team"];
  return (
    <dialog ref={ref} className="sheet" aria-labelledby="sheet-h" aria-describedby="sheet-intro" onCancel={(e) => { e.preventDefault(); onCancel(); }}>
      <h2 id="sheet-h">{CONFIRM.title}</h2>
      <p id="sheet-intro">{CONFIRM.intro}</p>
      <div className="sheet-cols">
        <div>
          <h3>{CONFIRM.will}</h3>
          <ul className="checklist">{will.map((w) => <li key={w} className="ok">{w}</li>)}</ul>
        </div>
        <div>
          <h3>{CONFIRM.willNot}</h3>
          <ul className="checklist not">{CONFIRM.willNotItems.map((w) => <li key={w} className="neutral">{w}</li>)}</ul>
        </div>
      </div>
      <p className="hint">{CONFIRM.checkedFirst}</p>
      <div className="sheet-actions">
        <button className="btn secondary" onClick={onCancel}>{CONFIRM.cancel}</button>
        <button ref={confirmRef} className="btn primary" onClick={onConfirm}>{CONFIRM.confirm}</button>
      </div>
    </dialog>
  );
}
