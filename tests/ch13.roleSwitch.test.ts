/** V3 CH-13: the demo switch is offered only when it would actually help, and only in SIMULATED mode. */
import { describe, expect, it } from "vitest";
import type { Run } from "../src/orchestrator/runTypes";
import { eligibleDemoSwitch } from "../src/ui/roleSwitch";

const runWith = (status: Run["status"]) => ({ status } as unknown as Run);

describe("eligibleDemoSwitch", () => {
  it("offers PA specialist to a viewer or admin who is blocked from checking or staging", () => {
    expect(eligibleDemoSwitch("viewer", "SIMULATED", null)).toEqual({ to: "pa-specialist", action: "check" });
    expect(eligibleDemoSwitch("sim-admin", "SIMULATED", runWith("AWAITING_CONFIRMATION"))).toEqual({ to: "pa-specialist", action: "stage" });
    expect(eligibleDemoSwitch("viewer", "SIMULATED", runWith("FAILED_RETRYABLE"))).toEqual({ to: "pa-specialist", action: "stage" });
  });
  it("offers nothing when the PA specialist could not act either", () => {
    for (const s of ["COMPLETED", "NO_ACTION", "NO_GAP", "REEVALUATION_REQUIRED", "FAILED", "EXECUTING", "EVALUATING"] as const) {
      expect(eligibleDemoSwitch("viewer", "SIMULATED", runWith(s)), s).toBeNull();
    }
  });
  it("offers nothing to the PA specialist, or outside SIMULATED mode", () => {
    expect(eligibleDemoSwitch("pa-specialist", "SIMULATED", null)).toBeNull();
    expect(eligibleDemoSwitch("viewer", "SANDBOX", null)).toBeNull();
    expect(eligibleDemoSwitch("viewer", "LIVE", runWith("AWAITING_CONFIRMATION"))).toBeNull();
    expect(eligibleDemoSwitch("viewer", null, null)).toBeNull();
  });
});
