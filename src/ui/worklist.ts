/**
 * Product P3: queue presentation. The only place that maps a draft's latest
 * check to a queue status, group and order. Pure; reads only what the server
 * recorded and decides nothing.
 */
import type { WorklistItem } from "../server/worklist";

export type QueueKey = "attention" | "ready" | "recheck" | "records" | "person" | "retry" | "unchecked" | "busy" | "no-access" | "staged" | "complete";
export type QueueGroup = "needs-you" | "not-checked" | "no-action" | "done";
export type QueueStatus = { key: QueueKey; label: string; hint: string; tone: "ok" | "warn" | "bad" | "info" | "neutral"; group: QueueGroup; priority: number };

const S = (key: QueueKey, label: string, hint: string, tone: QueueStatus["tone"], group: QueueGroup, priority: number): QueueStatus => ({ key, label, hint, tone, group, priority });

export function queueStatus(item: Pick<WorklistItem, "latest" | "businessStatus">): QueueStatus {
  const r = item.latest;
  if (!r) return S("unchecked", "Not checked yet", "", "neutral", "not-checked", 3);
  switch (r.status) {
    case "AWAITING_CONFIRMATION":
      return S("ready", "Evidence ready for you", "Review it and stage the task", "ok", "needs-you", 0);
    case "FAILED_RETRYABLE":
      return S("ready", "Staging did not finish", "Safe to try staging again", "warn", "needs-you", 0);
    case "FAILED":
      return S("attention", "Needs attention", r.decision ? "The task could not be verified" : "The check failed", "bad", "needs-you", 0);
    case "COMPLETED":
      return S("staged", "Review task created", "Waiting for the evidence review", "info", "done", 6);
    case "NO_GAP":
      return S("complete", "Nothing missing", "The record is already in the chart", "ok", "done", 7);
    case "EVALUATING":
    case "EXECUTING":
      return S("busy", "Working…", "Please wait", "neutral", "needs-you", 2);
    case "REEVALUATION_REQUIRED":
      return S("recheck", "Draft changed", "Run the check again", "warn", "needs-you", 1);
    case "NO_ACTION":
      if (r.refusal) return S("recheck", "Stopped before writing", "Run the check again", "warn", "needs-you", 1);
      switch (r.outcomeState) {
        case "CLAIM_SOURCE_FOLLOWUP":
          return S("records", "Request records", "Only billing records were found", "warn", "needs-you", 1);
        case "MANUAL_REVIEW":
          return S("person", "A person must look", "The document could not be used automatically", "warn", "needs-you", 1);
        case "REEVALUATION_REQUIRED":
          return S("recheck", "Check again", "The draft or checklist changed", "warn", "needs-you", 1);
        case "SOURCE_UNAVAILABLE":
          return S("retry", "Source did not answer", "Try the check again later", "warn", "needs-you", 2);
        case "ACCESS_NOT_PERMITTED":
          return S("no-access", "Outside records not allowed", "Use your usual records request", "neutral", "no-action", 4);
        default:
          return S("no-access", "No task for this outcome", "See the reasons", "neutral", "no-action", 5);
      }
  }
  return S("attention", "Needs attention", "Unknown status", "bad", "needs-you", 0);
}

export const GROUP_LABEL: Record<QueueGroup, string> = {
  "needs-you": "Needs you",
  "not-checked": "Not checked yet",
  "no-action": "No action possible",
  done: "Done",
};
export const GROUP_ORDER: QueueGroup[] = ["needs-you", "not-checked", "no-action", "done"];

/** Queue order: most urgent first, then the scenario's draft, then by id. Stable. */
export function sortQueue<T extends Pick<WorklistItem, "latest" | "businessStatus" | "draftId" | "scenarioDraft">>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const pa = queueStatus(a).priority;
    const pb = queueStatus(b).priority;
    if (pa !== pb) return pa - pb;
    if (a.scenarioDraft !== b.scenarioDraft) return a.scenarioDraft ? -1 : 1;
    return a.draftId.localeCompare(b.draftId);
  });
}

/** Default selection: the most urgent draft. */
export function defaultSelection(items: Parameters<typeof sortQueue>[0]): string | null {
  return sortQueue(items)[0]?.draftId ?? null;
}

/** The next draft that needs a person, after the current one. */
export function nextNeedingYou<T extends Parameters<typeof sortQueue>[0][number]>(items: T[], current: string | null): T | null {
  return sortQueue(items).find((i) => i.draftId !== current && queueStatus(i).group === "needs-you" && queueStatus(i).key !== "busy") ?? null;
}

/** Drafts the bulk check may run on: never checked. Never includes a write. */
export function uncheckedDrafts(items: Array<Pick<WorklistItem, "draftId" | "latest">>): string[] {
  return items.filter((i) => !i.latest).map((i) => i.draftId);
}

export function groupCounts(items: Array<Pick<WorklistItem, "latest" | "businessStatus">>): Record<QueueGroup, number> {
  const out: Record<QueueGroup, number> = { "needs-you": 0, "not-checked": 0, "no-action": 0, done: 0 };
  for (const i of items) out[queueStatus(i).group] += 1;
  return out;
}
