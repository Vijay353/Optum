/** V3 final report, invariant evidence: a forged or unknown demo role header never gains write authority. */
import { afterEach, describe, expect, it } from "vitest";
import { api, countRows, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

describe("forged demo role", () => {
  it.each(["admin", "superuser", "PA-SPECIALIST", "pa-specialist,sim-admin", "pa_specialist", ""])("role header %j is treated as a read-only viewer", async (role) => {
    env = await startTestServer({ scenario: "primary-success" });
    expect((await api(env, "POST", "/api/drafts/PA-DRAFT-99412/check", undefined, role)).status).toBe(403);
    const run = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    expect((await api(env, "POST", `/api/runs/${run.runId}/stage`, undefined, role)).status).toBe(403);
    expect(countRows(env.db, "ehr_tasks")).toBe(0);
  });
});
