/**
 * Product P10: pitch mode is presentation only, and the tour ticks steps from
 * real recorded state.
 */
import { afterEach, describe, expect, it } from "vitest";
import { api, startTestServer, type TestEnv } from "./helpers";
import { loadConfig } from "../src/server/config";
import { resolveUiMode, tourSteps } from "../src/ui/pitch";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

describe("ui mode", () => {
  it("defaults to demo; EB_UI_MODE=pitch selects pitch; anything else warns and stays demo", () => {
    expect(loadConfig({ EB_MODE: "SIMULATED" }).uiMode).toBe("demo");
    expect(loadConfig({ EB_MODE: "SIMULATED", EB_UI_MODE: "pitch" }).uiMode).toBe("pitch");
    const c = loadConfig({ EB_MODE: "SIMULATED", EB_UI_MODE: "investor" });
    expect(c.uiMode).toBe("demo");
    expect(c.warnings.join(" ")).toMatch(/EB_UI_MODE/);
    expect(c.errors).toEqual([]);
  });
  it("the query string overrides the server default in both directions", () => {
    expect(resolveUiMode("demo", "?mode=pitch")).toBe("pitch");
    expect(resolveUiMode("pitch", "?mode=demo")).toBe("demo");
    expect(resolveUiMode("pitch", "")).toBe("pitch");
    expect(resolveUiMode(undefined, "?mode=other")).toBe("demo");
  });
  it("pitch mode changes no server behaviour: a viewer is still refused", async () => {
    env = await startTestServer({ scenario: "primary-success", env: { EB_UI_MODE: "pitch" } });
    expect((await api<{ uiMode: string }>(env, "GET", "/api/health")).body.uiMode).toBe("pitch");
    expect((await api(env, "POST", "/api/drafts/PA-DRAFT-99412/check", undefined, "viewer")).status).toBe(403);
  });
});

describe("tour steps", () => {
  const L = (status: string) => ({ latest: { runId: "r", status, decision: null, outcomeState: null, createdAt: "t", refusal: null } });
  it("nothing is done before anything happens", () => {
    expect(tourSteps({ items: [{ latest: null }, { latest: null }], selectedStatus: null, packetOpened: false }).map((s) => s.done)).toEqual([false, false, false, false]);
  });
  it("ticks only what the records show", () => {
    const checked = [L("AWAITING_CONFIRMATION"), L("NO_ACTION")];
    expect(tourSteps({ items: checked, selectedStatus: "AWAITING_CONFIRMATION", packetOpened: false }).map((s) => s.done)).toEqual([true, true, false, false]);
    const staged = [L("COMPLETED"), L("NO_ACTION")];
    expect(tourSteps({ items: staged, selectedStatus: "COMPLETED", packetOpened: true }).map((s) => s.done)).toEqual([true, true, true, true]);
  });
});
