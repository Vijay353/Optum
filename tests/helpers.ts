import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { openDb, type Db } from "../src/persistence/db";
import { createApp, type AppHandle } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { loadScenario } from "../src/server/scenarios";
import { setLogSilent } from "../src/server/logger";
import type { EvidenceExtractor } from "../src/agents/EvidenceExtractor";
import type { Clock } from "../src/domain/clock";

export type TestEnv = { db: Db; baseUrl: string; handle: AppHandle; close: () => Promise<void> };

export async function startTestServer(opts: { scenario?: string; env?: Record<string, string>; extractor?: EvidenceExtractor; clock?: Clock } = {}): Promise<TestEnv> {
  setLogSilent(true);
  const config = loadConfig({
    EB_MODE: "SIMULATED",
    EB_HTTP_TIMEOUT_MS: "250",
    EB_HTTP_MAX_RETRIES: "2",
    EB_HTTP_BACKOFF_MS: "10",
    ...opts.env,
  });
  const db = openDb(":memory:");
  if (opts.scenario) loadScenario(db, opts.scenario, { faultOverrides: shortenTimeouts(opts.scenario) });
  const handle = createApp({ db, config, extractor: opts.extractor, clock: opts.clock });
  const server: Server = await new Promise((resolve) => {
    const s = handle.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  handle.setBaseUrl(baseUrl);
  return {
    db,
    baseUrl,
    handle,
    close: () => new Promise<void>((r) => server.close(() => { db.close(); r(); })),
  };
}

/** Test runs use a 250 ms client timeout; shrink scenario timeout faults to match. */
function shortenTimeouts(scenario: string) {
  if (scenario === "source-unavailable") return { "payer.eob": { kind: "timeout" as const, delayMs: 400, remaining: null } };
  return {};
}

export async function api<T = unknown>(env: TestEnv, method: string, path: string, body?: unknown, role = "pa-specialist"): Promise<{ status: number; body: T }> {
  const res = await fetch(`${env.baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-demo-role": role },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

export function countRows(db: Db, table: string, where = "1=1", ...args: string[]): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args) as { n: number }).n;
}
