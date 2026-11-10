/**
 * Review task due state (V3 CH-5, refined for EvidenceBridge).
 *
 * A review Task carries its own due time (restriction.period.end). This pure
 * function derives, on read, whether the review is on time, due soon or
 * overdue, using the scenario clock. It never changes anything: an overdue
 * review is flagged for the owning queue, nothing moves forward and no other
 * role gains authority.
 */
export type ReviewDueState = "ON_TIME" | "DUE_SOON" | "OVERDUE";

export type ReviewDue = {
  state: ReviewDueState;
  dueAt: string;
  /** Whole hours left before the due time (0 when overdue). */
  hoursLeft: number;
  /** Whole hours past the due time (0 when not overdue). */
  hoursOverdue: number;
};

export const DUE_SOON_HOURS = 12;

export function reviewDue(dueAtIso: string, now: Date): ReviewDue {
  const due = Date.parse(dueAtIso);
  if (Number.isNaN(due)) throw new RangeError(`invalid due time: ${dueAtIso}`);
  const diff = due - now.getTime();
  const H = 3600_000;
  // At the exact due time the review counts as overdue.
  if (diff <= 0) return { state: "OVERDUE", dueAt: new Date(due).toISOString(), hoursLeft: 0, hoursOverdue: Math.floor(Math.max(0, -diff) / H) };
  return {
    state: diff <= DUE_SOON_HOURS * H ? "DUE_SOON" : "ON_TIME",
    dueAt: new Date(due).toISOString(),
    hoursLeft: Math.floor(diff / H),
    hoursOverdue: 0,
  };
}
