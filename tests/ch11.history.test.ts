/** V3 CH-11: every check for a draft is kept and listed oldest first. */
import { afterEach, describe, expect, it } from "vitest";
import { api, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });
type Ws = { runHistory: Array<{ runId: string; eventId: string; deliveryCount: number; status: string; decision: string | null }> };

describe("run history for a draft", () => {
  it("zero, one and many checks; redeliveries are kept; order is oldest first", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    expect((await api<Ws>(env, "GET", "/api/workspace")).body.runHistory).toEqual([]);
    const a = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    expect((await api<Ws>(env, "GET", "/api/workspace")).body.runHistory.map((r) => r.runId)).toEqual([a.runId]);
    await api(env, "POST", `/api/runs/${a.runId}/stage`);
    const b = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run; // same event redelivered
    const h = (await api<Ws>(env, "GET", "/api/workspace")).body.runHistory;
    expect(h.map((r) => r.runId)).toEqual([a.runId, b.runId]);
    expect(h[0]).toMatchObject({ status: "COMPLETED", deliveryCount: 1, eventId: "evt-pa-99412-v3" });
    expect(h[1]).toMatchObject({ deliveryCount: 2, eventId: "evt-pa-99412-v3" });
  });
  it("only this draft's checks are listed", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    await api(env, "POST", "/api/drafts/PA-DRAFT-99413/check");
    expect((await api<Ws>(env, "GET", "/api/workspace")).body.runHistory).toEqual([]);
  });
});
