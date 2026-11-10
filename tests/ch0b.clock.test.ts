/**
 * CH-0B: a fixed scenario clock set per fixture and injected into the
 * orchestrator and simulators. Results no longer depend on the wall clock.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, countRows, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";
import { ManualClock } from "../src/domain/clock";
import { openDb } from "../src/persistence/db";
import { advanceScenarioClock, ScenarioClock, setScenarioTime } from "../src/persistence/scenarioClock";
import { listScenarios, loadScenario } from "../src/server/scenarios";

let env: TestEnv | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await env?.close();
  env = undefined;
});

const H = 3600_000;
const check = async (e: TestEnv) => (await api<{ run: Run }>(e, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;

describe("clock units", () => {
  it("ManualClock only moves when told", () => {
    const c = new ManualClock("2026-10-18T13:10:00Z");
    expect(c.now().toISOString()).toBe("2026-10-18T13:10:00.000Z");
    c.advance(H);
    expect(c.now().toISOString()).toBe("2026-10-18T14:10:00.000Z");
  });

  it("ScenarioClock = scenario start + real elapsed + demo offset", () => {
    const db = openDb(":memory:");
    let real = 1_000_000;
    const clock = new ScenarioClock(db, () => real);
    expect(clock.state().mode).toBe("system");
    setScenarioTime(db, "2026-10-18T13:10:00Z", () => real);
    expect(clock.now().toISOString()).toBe("2026-10-18T13:10:00.000Z");
    real += 90_000;
    expect(clock.now().toISOString()).toBe("2026-10-18T13:11:30.000Z");
    advanceScenarioClock(db, 25 * H);
    expect(clock.now().toISOString()).toBe("2026-10-19T14:11:30.000Z");
    expect(() => advanceScenarioClock(db, 0)).toThrow(RangeError);
    expect(() => advanceScenarioClock(db, -H)).toThrow(RangeError);
    // Loading the scenario again resets the offset.
    setScenarioTime(db, "2026-10-18T13:10:00Z", () => real);
    expect(clock.state()).toMatchObject({ mode: "scenario", offsetMs: 0, now: "2026-10-18T13:10:00.000Z" });
    db.close();
  });

  it("every shipped scenario fixes a start time", () => {
    for (const s of listScenarios()) expect(s.scenarioTime, s.id).toBe("2026-10-18T13:10:00Z");
  });
});

describe("results do not depend on the wall clock", () => {
  it.each(["2026-11-09T19:00:00Z", "2027-03-15T12:00:00Z", "2027-09-01T00:00:00Z"])("primary scenario at wall time %s", async (wall) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(wall));
    env = await startTestServer({ scenario: "primary-success" });
    const c = await check(env);
    expect(c.event.occurredAt.startsWith("2026-10-18T13:1")).toBe(true);
    expect(c.policyResult?.decision).toBe("REVIEW_EXTERNAL_EVIDENCE");
    expect(c.claims?.leadCount).toBe(12);
    expect(c.claims?.firstDate).toBe("2026-01-12");
    expect(c.lookback?.windowStart).toBe("2025-10-18");
    const s = (await api<{ run: Run }>(env, "POST", `/api/runs/${c.runId}/stage`)).body.run;
    expect(s.status).toBe("COMPLETED");
  });

  it("business timestamps across simulators use scenario time", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const c = await check(env);
    const s = (await api<{ run: Run }>(env, "POST", `/api/runs/${c.runId}/stage`)).body.run;
    const day = "2026-10-18";
    expect(s.createdAt.startsWith(day)).toBe(true);
    expect(s.execution.readback?.task?.authoredOn.startsWith(day)).toBe(true);
    expect(s.stagedToolInput?.dueAt.startsWith("2026-10-20")).toBe(true);
    for (const t of ["ehr_audit", "app_audit", "payer_access_log", "hie_access_log"]) {
      expect(countRows(env.db, t, "at NOT LIKE ?", `${day}%`), t).toBe(0);
      expect(countRows(env.db, t), t).toBeGreaterThan(0);
    }
  });
});

describe("clock API and demo control", () => {
  it("moving time forward 25 hours makes an evaluated run too old to stage", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const c = await check(env);
    expect((await api(env, "POST", "/api/clock/advance", { hours: 25 }, "viewer")).status).toBe(403);
    expect((await api(env, "POST", "/api/clock/advance", { hours: 0 })).status).toBe(400);
    const moved = await api<{ offsetMs: number; now: string }>(env, "POST", "/api/clock/advance", { hours: 25 });
    expect(moved.body.offsetMs).toBe(25 * H);
    expect(moved.body.now.startsWith("2026-10-19T14:1")).toBe(true);
    const s = (await api<{ run: Run }>(env, "POST", `/api/runs/${c.runId}/stage`)).body.run;
    expect(s.execution.preWriteCheck?.refusal).toBe("RUN_TOO_OLD");
    expect(countRows(env.db, "ehr_tasks")).toBe(0);
    // Reloading the scenario resets scenario time.
    await api(env, "POST", "/api/scenarios/primary-success/load");
    expect((await api<{ offsetMs: number }>(env, "GET", "/api/clock")).body.offsetMs).toBe(0);
  });

  it("an injected clock drives the orchestrator and cannot be moved by the API", async () => {
    const clock = new ManualClock("2026-10-18T13:10:00Z");
    env = await startTestServer({ scenario: "primary-success", clock });
    const c = await check(env);
    expect(c.event.occurredAt).toBe("2026-10-18T13:10:00.000Z");
    expect((await api(env, "POST", "/api/clock/advance", { hours: 1 })).status).toBe(409);
    clock.advance(24 * H + 60_000);
    const s = (await api<{ run: Run }>(env, "POST", `/api/runs/${c.runId}/stage`)).body.run;
    expect(s.execution.preWriteCheck).toMatchObject({ runAgeMinutes: 1441, refusal: "RUN_TOO_OLD" });
  });

  it("a fixture without scenarioTime falls back to the system clock", () => {
    const dir = mkdtempSync(join(tmpdir(), "eb-fixtures-"));
    cpSync("fixtures/base", join(dir, "base"), { recursive: true });
    mkdirSync(join(dir, "legacy"));
    const sc = JSON.parse(readFileSync("fixtures/primary-success/scenario.json", "utf8"));
    delete sc.scenarioTime;
    writeFileSync(join(dir, "legacy", "scenario.json"), JSON.stringify({ ...sc, id: "legacy" }));
    const db = openDb(":memory:");
    loadScenario(db, "legacy", {}, dir);
    expect(new ScenarioClock(db).state().mode).toBe("system");
    db.close();
  });
});
