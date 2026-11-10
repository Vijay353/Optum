/**
 * Lifecycle stepper presentation (V3 CH-14). The only place that maps run
 * status to the three steps. Runs can stop, fail or skip steps, so the
 * stepper never implies a guaranteed linear path.
 */
import type { Run } from "../orchestrator/runTypes";

export type StepState = "done" | "current" | "todo" | "stopped" | "failed" | "skipped";
export type Stepper = { steps: Array<{ label: string; state: StepState }>; outcome: string | null };

const LABELS = ["Check draft", "Review evidence", "Stage review task"] as const;

function make(states: [StepState, StepState, StepState], outcome: string | null): Stepper {
  return { steps: LABELS.map((label, i) => ({ label, state: states[i]! })), outcome };
}

export function stepperFor(run: Run | null): Stepper {
  if (!run) return make(["current", "todo", "todo"], null);
  const attempted = !!run.execution.confirmedBy;
  switch (run.status) {
    case "EVALUATING":
      return make(["current", "todo", "todo"], "Checking sources");
    case "AWAITING_CONFIRMATION":
      return make(["done", "current", "todo"], "Waiting for a PA specialist to stage the task");
    case "EXECUTING":
      return make(["done", "done", "current"], "Writing the task");
    case "COMPLETED":
      return make(["done", "done", "done"], "Task staged and verified");
    case "NO_GAP":
      return make(["done", "skipped", "skipped"], "Nothing missing, no review needed");
    case "NO_ACTION":
      return attempted
        ? make(["done", "done", "stopped"], "Stopped at the final check, nothing written")
        : make(["done", "stopped", "skipped"], "No task for this outcome");
    case "REEVALUATION_REQUIRED":
      return attempted
        ? make(["done", "done", "stopped"], "Write refused, run the check again")
        : make(["done", "stopped", "skipped"], "Draft or policy changed, run the check again");
    case "FAILED_RETRYABLE":
      return make(["done", "done", "failed"], "Did not finish, safe to retry");
    case "FAILED":
      return attempted ? make(["done", "done", "failed"], "Write not verified") : make(["failed", "skipped", "skipped"], "Check failed");
  }
}

export const STATE_TEXT: Record<StepState, string> = {
  done: "done", current: "current step", todo: "not started", stopped: "stopped", failed: "failed", skipped: "skipped",
};
export const STATE_MARK: Record<StepState, string> = { done: "✓", current: "", todo: "", stopped: "–", failed: "!", skipped: "·" };
