/**
 * Inline demo role switch (V3 CH-13). Offered only in SIMULATED mode, only
 * when the current demo role is blocked, and only if the offered role could
 * actually perform the action. It changes the demo identity header only; the
 * server still checks every action. This is not authentication.
 */
import type { Run } from "../orchestrator/runTypes";
import type { Role } from "./api";

export type BlockedAction = "check" | "stage";

export function eligibleDemoSwitch(role: Role, mode: string | null, run: Run | null): { to: Role; action: BlockedAction } | null {
  if (mode !== "SIMULATED" || role === "pa-specialist") return null;
  if (!run) return { to: "pa-specialist", action: "check" };
  if (run.status === "AWAITING_CONFIRMATION" || run.status === "FAILED_RETRYABLE") return { to: "pa-specialist", action: "stage" };
  return null;
}
