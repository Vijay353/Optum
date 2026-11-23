/**
 * Product P4 (spec CH-1.6): truthful async states. A skeleton keeps the
 * layout while loading (no spinner, no layout jump); an error says what
 * happened, what was not affected, and the one way to recover.
 */
import type { ReactNode } from "react";
import { ERRORS } from "./copy";

export function Skeleton({ lines = 3, label }: { lines?: number; label: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => <span key={i} className="skeleton-line" style={{ width: `${92 - i * 14}%` }} />)}
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty-note">{children}</p>;
}

export function ErrorNote({ what, detail, onRetry }: { what: string; detail?: string | null; onRetry?: () => void }) {
  return (
    <div className="alert bad" role="alert">
      <p><strong>{what}</strong>{detail ? ` ${detail}` : ""}</p>
      <p>{ERRORS.notAffected}</p>
      {onRetry && <button className="btn secondary" onClick={onRetry}>{ERRORS.retry}</button>}
    </div>
  );
}
