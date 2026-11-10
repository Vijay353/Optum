import { useEffect, useRef } from "react";
import type { EvidenceFact } from "../domain/contracts";

/** Shows the source document pages with each cited span highlighted at its exact offsets. */
export function CitationViewer({ pages, facts, documentId, onClose }: { pages: string[]; facts: EvidenceFact[]; documentId: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal?.();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <dialog ref={ref} className="citation-dialog" aria-labelledby="cite-title" onClose={onClose}>
      <header>
        <h2 id="cite-title">Cited source · {documentId}</h2>
        <button className="btn secondary" onClick={onClose} autoFocus>Close</button>
      </header>
      <p className="muted">Synthetic document. Highlighted spans are the exact character ranges the extractor cited; each was re-verified against this text.</p>
      {pages.map((text, i) => {
        const spans = facts.filter((f) => f.sourcePage === i + 1).sort((a, b) => a.sourceStart - b.sourceStart);
        const parts: React.ReactNode[] = [];
        let cur = 0;
        for (const f of spans) {
          if (f.sourceStart < cur) continue;
          parts.push(text.slice(cur, f.sourceStart));
          parts.push(<mark key={f.field} title={`${f.field} · page ${f.sourcePage} · chars ${f.sourceStart}–${f.sourceEnd}`}>{text.slice(f.sourceStart, f.sourceEnd)}</mark>);
          cur = f.sourceEnd;
        }
        parts.push(text.slice(cur));
        return (
          <section key={i} className="cite-page">
            <h3>Page {i + 1}</h3>
            <pre>{parts}</pre>
          </section>
        );
      })}
      <table className="mini">
        <thead><tr><th>Field</th><th>Normalized value</th><th>Page</th><th>Offsets</th></tr></thead>
        <tbody>{facts.map((f) => <tr key={f.field}><td>{f.field}</td><td>{String(f.normalizedValue)}</td><td>{f.sourcePage}</td><td>{f.sourceStart}–{f.sourceEnd}</td></tr>)}</tbody>
      </table>
    </dialog>
  );
}
