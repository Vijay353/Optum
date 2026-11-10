/** V3 CH-21: analytics only after entry and consent; fixed event names; masking; silent no-op without an id. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVENTS, _resetForTests, environmentAllows, eventsFor, installClarity, readConsent, track, trackEntered, withdraw, writeConsent } from "../src/ui/analytics";
import { loadConfig } from "../src/server/config";
import { api, startTestServer, type TestEnv } from "./helpers";

const SETTINGS = { provider: "clarity" as const, projectId: "ebtest01", allowLocal: false };
const SECRET = "e".repeat(48);

function fakeDom() {
  const scripts: { src: string; async: boolean }[] = [];
  const calls: unknown[][] = [];
  const doc = { createElement: () => ({ src: "", async: false }), head: { appendChild: (s: { src: string; async: boolean }) => scripts.push(s) } } as unknown as Document;
  const win: Record<string, unknown> = {};
  return { doc, win, scripts, calls: () => ((win.clarity as { q?: unknown[][] })?.q ?? calls) };
}

beforeEach(() => _resetForTests());

describe("when analytics may load", () => {
  it("never on localhost or under automation unless the server explicitly allows it; never without a valid id", () => {
    expect(environmentAllows(SETTINGS, { hostname: "demo.example.org", webdriver: false })).toBe(true);
    for (const h of ["localhost", "127.0.0.1", "[::1]", "app.localhost"]) expect(environmentAllows(SETTINGS, { hostname: h, webdriver: false })).toBe(false);
    expect(environmentAllows(SETTINGS, { hostname: "demo.example.org", webdriver: true })).toBe(false);
    expect(environmentAllows({ ...SETTINGS, allowLocal: true }, { hostname: "127.0.0.1", webdriver: true })).toBe(true);
    expect(environmentAllows(null, { hostname: "demo.example.org", webdriver: false })).toBe(false);
    expect(environmentAllows({ ...SETTINGS, projectId: "x\"><script>" }, { hostname: "demo.example.org", webdriver: false })).toBe(false);
  });

  it("consent is read and written safely, including when storage throws", () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readConsent(s)).toBeNull();
    writeConsent(s, "granted");
    expect(readConsent(s)).toBe("granted");
    store.set("eb.analytics.consent", "maybe");
    expect(readConsent(s)).toBeNull();
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readConsent(broken)).toBeNull();
    expect(() => writeConsent(broken, "denied")).not.toThrow();
  });
});

describe("loader and events", () => {
  it("installs once per page, with analytics storage granted and ad storage denied", () => {
    const d = fakeDom();
    expect(installClarity(d.win as never, d.doc, "ebtest01")).toBe(true);
    expect(installClarity(d.win as never, d.doc, "ebtest01")).toBe(false);
    expect(d.scripts).toEqual([{ src: "https://www.clarity.ms/tag/ebtest01", async: true }]);
    expect(d.calls()).toEqual([["consentv2", { ad_Storage: "denied", analytics_Storage: "granted" }]]);
  });

  it("nothing is sent before install; only the fixed names are sent after", () => {
    const d = fakeDom();
    track("scenario_started");
    expect(d.calls()).toEqual([]);
    installClarity(d.win as never, d.doc, "ebtest01");
    track("scenario_started");
    track("PA-DRAFT-99412" as never);
    const events = d.calls().filter((c) => c[0] === "event");
    expect(events).toEqual([["event", "scenario_started"]]);
  });

  it("project_entered fires once per browser session, not on every reload", () => {
    const d = fakeDom();
    installClarity(d.win as never, d.doc, "ebtest01");
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    trackEntered(s);
    trackEntered(s);
    expect(d.calls().filter((c) => c[1] === "project_entered")).toHaveLength(1);
  });

  it("withdrawal tells Clarity to deny and clear cookies, and stops further events", () => {
    const d = fakeDom();
    installClarity(d.win as never, d.doc, "ebtest01");
    withdraw();
    track("scenario_started");
    const tail = d.calls().slice(1);
    expect(tail).toEqual([["consentv2", { ad_Storage: "denied", analytics_Storage: "denied" }], ["consent", false]]);
  });

  it("events come from the run status only, and every name is on the approved list", () => {
    const run = (status: string) => ({ run: { status, runId: "RUN-1", event: { draftId: "PA-DRAFT-99412" } } });
    expect(eventsFor("load", { active: "primary-success" })).toEqual(["scenario_started"]);
    expect(eventsFor("check", run("AWAITING_CONFIRMATION"))).toEqual(["evidence_check_run"]);
    expect(eventsFor("check", run("ACCESS_NOT_PERMITTED"))).toEqual(["evidence_check_run", "scenario_completed"]);
    expect(eventsFor("stage", run("COMPLETED"))).toEqual(["scenario_completed"]);
    expect(eventsFor("stage", run("FAILED_RETRYABLE"))).toEqual([]);
    expect(eventsFor("simulate-edit", run("COMPLETED"))).toEqual([]);
    for (const e of EVENTS) expect(e).toMatch(/^[a-z_]+$/);
  });
});

describe("server settings", () => {
  let env: TestEnv | undefined;
  afterEach(async () => { await env?.close(); env = undefined; });

  it("no id: silent no-op; bad id: warning and off", () => {
    expect(loadConfig({}).analytics).toBeNull();
    const bad = loadConfig({ EB_CLARITY_PROJECT_ID: "not an id!" });
    expect(bad.analytics).toBeNull();
    expect(bad.warnings.join(" ")).toMatch(/Analytics stays off/);
    expect(bad.startupErrors).toEqual([]);
  });

  it("the id reaches the browser only behind the gate, after entry", async () => {
    env = await startTestServer({ env: { EB_CLARITY_PROJECT_ID: "ebtest01" } }); // gate off (loopback)
    expect((await api<{ analytics: unknown }>(env, "GET", "/api/health")).body.analytics).toBeNull();
    await env.close();
    env = await startTestServer({ env: { EB_CLARITY_PROJECT_ID: "ebtest01", EB_ACCESS_GATE: "on", EB_ACCESS_PIN: "2468", EB_SESSION_SECRET: SECRET } });
    expect((await api(env, "GET", "/api/health")).status).toBe(401); // before entry: nothing
    const login = await fetch(`${env.baseUrl}/gate/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "pin=2468" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const h = (await (await fetch(`${env.baseUrl}/api/health`, { headers: { cookie } })).json()) as { analytics: unknown };
    expect(h.analytics).toEqual({ provider: "clarity", projectId: "ebtest01", allowLocal: false });
    const gatePage = await (await fetch(`${env.baseUrl}/gate`)).text();
    expect(gatePage).not.toMatch(/clarity|ebtest01/i);
  });
});
