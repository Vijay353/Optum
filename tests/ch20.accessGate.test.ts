/** V3 CH-20: four-digit access gate. Server-verified, covers document, deep links, assets, API and simulators. */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { api, startTestServer, type TestEnv } from "./helpers";
import { COOKIE, LIMITS, createAccessGate, gateConfigFrom, safeNext, type GateConfig } from "../src/server/accessGate";
import { loadConfig } from "../src/server/config";
import type { Run } from "../src/orchestrator/runTypes";

const SECRET = "a".repeat(16) + "0123456789abcdef0123456789abcdef";
const ON = { EB_ACCESS_GATE: "on", EB_ACCESS_PIN: "2468", EB_SESSION_SECRET: SECRET };

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

const post = (base: string, path: string, form: Record<string, string>, cookie?: string) =>
  fetch(base + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(form).toString() });
const cookieFrom = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0]!;

describe("configuration", () => {
  it("off by default only on loopback; required on any public address", () => {
    expect(gateConfigFrom({}, "127.0.0.1")).toMatchObject({ gate: { enabled: false }, errors: [] });
    expect(gateConfigFrom({}, "0.0.0.0").gate.enabled).toBe(true);
    expect(gateConfigFrom({}, "0.0.0.0").errors.join(" ")).toMatch(/EB_ACCESS_PIN must be exactly 4 digits.*|EB_SESSION_SECRET/);
    expect(gateConfigFrom({ EB_ACCESS_GATE: "off" }, "0.0.0.0").errors.join(" ")).toMatch(/cannot be turned off while the server listens on 0\.0\.0\.0/);
    const ok = gateConfigFrom({ EB_ACCESS_PIN: "0042", EB_SESSION_SECRET: SECRET }, "0.0.0.0");
    expect(ok.errors).toEqual([]);
    expect(ok.gate).toMatchObject({ enabled: true, secureCookie: true, ttlMs: 120 * 60_000, trustProxy: false });
  });
  it("rejects weak or malformed secrets and settings at startup", () => {
    for (const pin of ["123", "12345", "abcd", " 1234", ""]) expect(gateConfigFrom({ ...ON, EB_ACCESS_PIN: pin }, "127.0.0.1").errors.join(" ")).toMatch(/exactly 4 digits/);
    expect(gateConfigFrom({ ...ON, EB_SESSION_SECRET: "short" }, "127.0.0.1").errors.join(" ")).toMatch(/at least 32/);
    expect(gateConfigFrom({ ...ON, EB_SESSION_SECRET: "REPLACE_ME".padEnd(40, "x") }, "127.0.0.1").errors.join(" ")).toMatch(/at least 32/);
    expect(gateConfigFrom({ ...ON, EB_TRUST_PROXY: "true" }, "127.0.0.1").errors.join(" ")).toMatch(/EB_TRUST_PROXY/);
    expect(gateConfigFrom({ ...ON, EB_TRUST_PROXY: "1" }, "127.0.0.1").gate.trustProxy).toBe(1);
    expect(loadConfig({ EB_HOST: "0.0.0.0" }).startupErrors.length).toBeGreaterThan(0);
    expect(loadConfig({}).startupErrors).toEqual([]);
  });
  it("next targets stay on this site and never loop to the gate", () => {
    expect(safeNext("/x?y=1")).toBe("/x?y=1");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil", "javascript:alert(1)", "/gate", "/gate?next=/x", "/a\r\nSet-Cookie: x", 5, undefined]) expect(safeNext(bad)).toBe("/");
  });
});

describe("whole app with the gate on", () => {
  it("without a session: document and deep links go to the gate; API, simulators and assets are refused; health is open", async () => {
    env = await startTestServer({ scenario: "primary-success", env: ON });
    const b = env.baseUrl;
    const doc = await fetch(`${b}/cases/PA-DRAFT-99412?tab=review`, { redirect: "manual", headers: { accept: "text/html" } });
    expect(doc.status).toBe(303);
    expect(doc.headers.get("location")).toBe(`/gate?next=${encodeURIComponent("/cases/PA-DRAFT-99412?tab=review")}`);
    const gatePage = await fetch(`${b}/gate`);
    expect(gatePage.status).toBe(200);
    const html = await gatePage.text();
    expect(html).toContain("Enter EvidenceBridge");
    expect(html).not.toMatch(/<script[^>]+src=|https?:\/\//); // loads nothing external
    expect([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(["data:,"]);
    expect(gatePage.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    expect((await api(env, "GET", "/api/workspace")).status).toBe(401);
    expect((await api<{ gate: boolean }>(env, "GET", "/api/workspace")).body.gate).toBe(true);
    expect((await fetch(`${b}/mock-ehr/prior-auth-drafts/PA-DRAFT-99412`, { headers: { authorization: "Bearer eb-sim-admin-local" } })).status).toBe(401);
    expect((await fetch(`${b}/assets/index.js`)).status).toBe(401);
    expect((await fetch(`${b}/api/workspace`, { headers: { "x-eb-internal": "guess", "x-demo-role": "sim-admin" } })).status).toBe(401);
    expect((await fetch(`${b}/healthz`)).status).toBe(200);
  });

  it("a wrong PIN gives a generic error and no cookie; the right PIN gives a signed HttpOnly session and returns to the deep link", async () => {
    env = await startTestServer({ scenario: "primary-success", env: ON });
    const b = env.baseUrl;
    const wrong = await post(b, "/gate/login", { pin: "2469", next: "/cases/1" });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    const wrongHtml = await wrong.text();
    expect(wrongHtml).toContain("That passcode did not work.");
    expect(wrongHtml).not.toContain("2468");
    const farWrong = await (await post(b, "/gate/login", { pin: "9999" })).text();
    expect(farWrong.match(/<p class="error"[^>]*>([^<]*)</)![1]).toBe(wrongHtml.match(/<p class="error"[^>]*>([^<]*)</)![1]); // same message, near or far

    await env.close();
    env = await startTestServer({ scenario: "primary-success", env: ON }); // fresh attempt counters
    const ok = await post(env.baseUrl, "/gate/login", { pin: "2468", next: "/cases/1?x=2" });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/cases/1?x=2");
    const sc = ok.headers.get("set-cookie")!;
    expect(sc).toMatch(new RegExp(`^${COOKIE}=v1\\.\\d+\\.[a-f0-9]{32}\\.[A-Za-z0-9_-]+; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200$`)); // no Secure on loopback http
    expect(sc).not.toContain("2468");
  });

  it("with a session the whole workflow works (in-process simulator calls pass); the role switch stays a separate check", async () => {
    env = await startTestServer({ scenario: "primary-success", env: ON });
    const cookie = cookieFrom(await post(env.baseUrl, "/gate/login", { pin: "2468" }));
    const call = (method: string, path: string, role = "pa-specialist") =>
      fetch(env!.baseUrl + path, { method, headers: { cookie, "x-demo-role": role, "content-type": "application/json" } });
    const run = ((await (await call("POST", "/api/drafts/PA-DRAFT-99412/check")).json()) as { run: Run }).run;
    expect(run.status).toBe("AWAITING_CONFIRMATION");
    expect((await call("POST", `/api/runs/${run.runId}/stage`, "viewer")).status).toBe(403); // gate passed, role still refused
    const staged = ((await (await call("POST", `/api/runs/${run.runId}/stage`)).json()) as { run: Run }).run;
    expect(staged.status).toBe("COMPLETED");
    expect(staged.execution.readback?.verified).toBe(true);
    expect(JSON.stringify(staged.trace)).not.toContain("x-eb-internal");
    const health = (await (await call("GET", "/api/health")).json()) as { accessGate: boolean };
    expect(health.accessGate).toBe(true);
    // Logout clears the cookie and the same token stops working.
    const out = await post(env.baseUrl, "/gate/logout", {}, cookie);
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/gate");
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect((await call("GET", "/api/workspace")).status).toBe(401);
  });

  it("with the gate off (local default) nothing changes", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    expect((await api(env, "GET", "/api/workspace")).status).toBe(200);
    expect((await fetch(`${env.baseUrl}/gate`)).status).toBe(404);
    expect(((await api<{ accessGate: boolean }>(env, "GET", "/api/health")).body).accessGate).toBe(false);
  });
});

describe("rate limit, expiry and tampering (gate alone, controlled clock)", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));
  async function mount(cfg: Partial<GateConfig> = {}) {
    let t = 1_000_000;
    const gate = createAccessGate({ enabled: true, pin: "2468", secret: SECRET, ttlMs: 60_000, secureCookie: true, trustProxy: false, ...cfg }, { now: () => t });
    const app = express();
    app.set("trust proxy", cfg.trustProxy ?? false);
    app.use(gate.middleware);
    app.get("/api/x", (_q, s) => void s.json({ ok: true }));
    server = await new Promise<Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, advance: (ms: number) => { t += ms; } };
  }

  it("backs off progressively after a few failures, even for the right PIN, then recovers", async () => {
    const { base, advance } = await mount();
    for (let i = 0; i < LIMITS.freeFailures; i++) expect((await post(base, "/gate/login", { pin: "0000" })).status).toBe(401);
    const blocked = await post(base, "/gate/login", { pin: "2468" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("1");
    expect(await blocked.text()).toContain("Too many attempts");
    advance(1000);
    expect((await post(base, "/gate/login", { pin: "1111" })).status).toBe(401); // 4th failure: next wait is 2 s
    advance(1000);
    expect((await post(base, "/gate/login", { pin: "2468" })).status).toBe(429);
    advance(1000);
    const ok = await post(base, "/gate/login", { pin: "2468" });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("set-cookie")).toMatch(/; Secure$/);
  });

  it("brute force from many clients at once hits the global cap", async () => {
    const { base } = await mount({ trustProxy: 1 }); // one trusted proxy: X-Forwarded-For names the client
    const from = (ip: string, pin: string) =>
      fetch(`${base}/gate/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip }, body: `pin=${pin}` });
    for (let i = 0; i < LIMITS.globalMaxFailures; i++) expect((await from(`10.0.${Math.floor(i / 200)}.${i % 200}`, String(1000 + i))).status).toBe(401);
    const r = await from("10.9.9.9", "2468"); // a fresh client, even with the right PIN, waits
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("without a trusted proxy, X-Forwarded-For is ignored: spoofed addresses share one client's limit", async () => {
    const { base } = await mount();
    const from = (ip: string) =>
      fetch(`${base}/gate/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip }, body: "pin=0000" });
    for (let i = 0; i < LIMITS.freeFailures; i++) expect((await from(`10.1.1.${i}`)).status).toBe(401);
    expect((await from("10.1.1.99")).status).toBe(429);
  });

  it("failures are remembered between attempts (not reset by cleanup)", async () => {
    const { base, advance } = await mount();
    for (let i = 0; i < LIMITS.freeFailures - 1; i++) { await post(base, "/gate/login", { pin: "0000" }); advance(5 * 60_000); }
    await post(base, "/gate/login", { pin: "0000" });
    expect((await post(base, "/gate/login", { pin: "2468" })).status).toBe(429);
  });

  it("an expired, tampered or foreign-secret cookie returns to the gate", async () => {
    const { base, advance } = await mount();
    const cookie = cookieFrom(await post(base, "/gate/login", { pin: "2468" }));
    const get = (c: string) => fetch(`${base}/api/x`, { headers: { cookie: c } });
    expect((await get(cookie)).status).toBe(200);
    const [name, value] = cookie.split("=") as [string, string];
    const parts = value.split(".");
    expect((await get(`${name}=${parts[0]}.${Number(parts[1]) + 999999}.${parts[2]}.${parts[3]}`)).status).toBe(401); // extended expiry, bad signature
    expect((await get(`${name}=${value.slice(0, -2)}xx`)).status).toBe(401);
    advance(60_001);
    expect((await get(cookie)).status).toBe(401);
  });
});
