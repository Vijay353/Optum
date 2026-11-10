/**
 * Terminal demo: boots the simulators + API on an ephemeral port with an
 * in-memory database and drives real HTTP requests through every scenario.
 * Usage: npm run demo:cli  [-- scenario-id]
 */
import type { AddressInfo } from "node:net";
import { openDb } from "../src/persistence/db";
import { createApp } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { listScenarios, loadScenario } from "../src/server/scenarios";
import { setLogSilent } from "../src/server/logger";
import type { Run } from "../src/orchestrator/runTypes";

setLogSilent(true);
const only = process.argv[2];
const config = loadConfig({ EB_MODE: "SIMULATED", EB_HTTP_TIMEOUT_MS: "300", EB_HTTP_BACKOFF_MS: "20" });
const db = openDb(":memory:");
const { app, setBaseUrl } = createApp({ db, config });
const server = app.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setBaseUrl(base);
  const post = async (path: string) => (await (await fetch(base + path, { method: "POST", headers: { "x-demo-role": "pa-specialist" } })).json()) as { run: Run };
  let failures = 0;
  for (const sc of listScenarios().filter((s) => !only || s.id === only)) {
    loadScenario(db, sc.id, { faultOverrides: sc.id === "source-unavailable" ? { "payer.eob": { kind: "timeout", delayMs: 500, remaining: null } } : {} });
    let run = (await post(`/api/drafts/${sc.draftId}/check`)).run;
    if (run.status === "AWAITING_CONFIRMATION") run = (await post(`/api/runs/${run.runId}/stage`)).run;
    const tasks = (db.prepare("SELECT COUNT(*) n FROM ehr_tasks").get() as { n: number }).n;
    const pass = run.policyResult?.decision === sc.expected.decision && run.outcomeState === sc.expected.outcomeState;
    if (!pass) failures++;
    console.log(`${pass ? "PASS" : "FAIL"}  ${sc.id.padEnd(20)} decision=${String(run.policyResult?.decision).padEnd(25)} outcome=${String(run.outcomeState).padEnd(24)} status=${run.status.padEnd(22)} tasks=${tasks}`);
    if (only || sc.id === "primary-success") {
      for (const t of run.trace) {
        const calls = t.calls.map((c) => `${c.method} ${c.path.split("?")[0]} → ${c.status ?? c.outcome}`).join("; ");
        console.log(`      ${String(t.seq).padStart(2)} ${t.ok ? "✓" : "✗"} ${t.step.padEnd(36)} ${t.summary}${calls ? `\n         ${calls}` : ""}`);
      }
    }
  }
  console.log(failures ? `\n${failures} scenario(s) did not match expectations` : "\nAll scenarios matched their expected decision and outcome.");
  server.close(() => { db.close(); process.exit(failures ? 1 : 0); });
});
