/**
 * Product P10 (spec CH-3.2): presentation mode and the guided tour. Pure.
 * Pitch mode only hides demo chrome; the server behaves exactly the same.
 * Tour steps are derived from real state, so the tour can never show a
 * success the system did not record.
 */
import type { WorklistItem } from "../server/worklist";

export type UiMode = "demo" | "pitch";

/** `?mode=pitch|demo` overrides the server default (escape hatch for Q&A). */
export function resolveUiMode(serverMode: string | undefined | null, search: string): UiMode {
  const q = new URLSearchParams(search).get("mode");
  if (q === "pitch" || q === "demo") return q;
  return serverMode === "pitch" ? "pitch" : "demo";
}

export type TourStep = { id: string; title: string; body: string; done: boolean };

export function tourSteps(state: { items: Array<Pick<WorklistItem, "latest">>; selectedStatus: string | null; packetOpened: boolean }): TourStep[] {
  const anyChecked = state.items.some((i) => !!i.latest);
  const allChecked = state.items.length > 0 && state.items.every((i) => !!i.latest);
  const staged = state.items.some((i) => i.latest?.status === "COMPLETED");
  const opened = state.selectedStatus === "AWAITING_CONFIRMATION" || state.selectedStatus === "COMPLETED";
  return [
    { id: "check", title: "Check the queue", body: "Press “Check all waiting drafts”. Each draft is checked against the documentation checklist, using only outside records the patient allows.", done: allChecked || (anyChecked && staged) },
    { id: "open", title: "Open a draft with evidence", body: "Pick a draft marked “Evidence ready for you”. The reasons and every check are one click away.", done: opened },
    { id: "stage", title: "Create the review task", body: "Press “Stage evidence review task” and confirm. This is the only write, and it is read back to prove it saved correctly.", done: staged },
    { id: "proof", title: "Show the proof", body: "Press “Print evidence summary”, or open the Metrics tab. Every number there comes from these runs.", done: staged && state.packetOpened },
  ];
}
