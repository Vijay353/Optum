/** V3 CH-14: the stepper maps every real run status honestly. */
import { afterEach, describe, expect, it } from "vitest";
import { api, startTestServer, type TestEnv } from "./helpers";
import { RUN_STATUSES, type Run } from "../src/orchestrator/runTypes";
import { stepperFor } from "../src/ui/stepper";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });
const fake = (status: Run["status"], confirmedBy: string | null) => ({ status, execution: { confirmedBy } } as unknown as Run);
const states = (r: Run | null) => stepperFor(r).steps.map((s) => s.state);

describe("stepperFor, exhaustive over RUN_STATUSES", () => {
  it.each(RUN_STATUSES.flatMap((s) => [[s, null], [s, "demo-pa-specialist"]] as const))("%s (confirmed by %s)", (status, by) => {
    const st = stepperFor(fake(status, by));
    expect(st.steps.map((s) => s.label)).toEqual(["Check draft", "Review evidence", "Stage review task"]);
    expect(st.outcome).toBeTruthy();
    // Never shows a later step as done after an earlier step that is not done.
    const firstNotDone = st.steps.findIndex((s) => s.state !== "done");
    if (firstNotDone >= 0) expect(st.steps.slice(firstNotDone).some((s) => s.state === "done")).toBe(false);
    // Only COMPLETED shows every step done.
    expect(st.steps.every((s) => s.state === "done")).toBe(status === "COMPLETED");
    // At most one current step.
    expect(st.steps.filter((s) => s.state === "current").length).toBeLessThanOrEqual(1);
  });
  it("no run yet: first step current", () => expect(states(null)).toEqual(["current", "todo", "todo"]));
});

describe("real runs", () => {
  it("opt-out stops at review; a refused write stops at staging", async () => {
    env = await startTestServer({ scenario: "opt-out" });
    expect(states((await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99414/check")).body.run)).toEqual(["done", "stopped", "skipped"]);
    await env.close();
    env = await startTestServer({ scenario: "stale-version" });
    const c = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    expect(states(c)).toEqual(["done", "current", "todo"]);
    const s = (await api<{ run: Run }>(env, "POST", `/api/runs/${c.runId}/stage`)).body.run;
    expect(stepperFor(s)).toMatchObject({ outcome: "Write refused, run the check again" });
    expect(states(s)).toEqual(["done", "done", "stopped"]);
  });
  it("readback mismatch is failed, never done", async () => {
    env = await startTestServer({ scenario: "readback-mismatch" });
    const c = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    const s = (await api<{ run: Run }>(env, "POST", `/api/runs/${c.runId}/stage`)).body.run;
    expect(states(s)).toEqual(["done", "done", "failed"]);
  });
});
