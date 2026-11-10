/** V3 CH-15: empty states say why they are empty. */
import { afterEach, describe, expect, it } from "vitest";
import { api, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";
import { claimsEmptyText, readbackEmptyText, recordsEmptyText } from "../src/ui/emptyStates";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });
const check = async (scenario: string, draft: string) => {
  env = await startTestServer({ scenario });
  return (await api<{ run: Run }>(env, "POST", `/api/drafts/${draft}/check`)).body.run;
};

describe("records", () => {
  it("filter with no match, nothing yet, and has rows", () => {
    expect(recordsEmptyText("patients", 8, "zzz")).toBe('No patients records match "zzz". 8 records exist without the search.');
    expect(recordsEmptyText("tasks", 0, "")).toMatch(/after a PA specialist stages one/);
    expect(recordsEmptyText("patients", 0, "")).toMatch(/Load a scenario or import a workbook/);
    expect(recordsEmptyText("patients", 8, "")).toBeNull();
  });
  it("the records API supplies the total needed to tell the cases apart", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const r = (await api<{ total: number; rows: unknown[] }>(env, "GET", "/api/data/records?entity=patients&q=zzz")).body;
    expect(r).toMatchObject({ total: 8, rows: [] });
  });
});

describe("claims and read-back", () => {
  it("not permitted vs not requested vs none found vs source down", async () => {
    expect(claimsEmptyText(await check("opt-out", "PA-DRAFT-99414"))).toBe("Not requested: Provider Access was not permitted.");
    await env!.close();
    expect(claimsEmptyText(await check("policy-superseded", "PA-DRAFT-99419"))).toBe("Not requested: the check stopped before claims were needed.");
    await env!.close();
    expect(claimsEmptyText(await check("source-unavailable", "PA-DRAFT-99412"))).toBe("Not available: a source did not respond.");
    await env!.close();
    expect(claimsEmptyText(await check("primary-success", "PA-DRAFT-99412"))).toBeNull();
  });
  it("read-back text follows the real state", async () => {
    const c = await check("primary-success", "PA-DRAFT-99412");
    expect(readbackEmptyText(c)).toBe("Nothing written yet. Read-back runs after staging.");
    const s = (await api<{ run: Run }>(env!, "POST", `/api/runs/${c.runId}/stage`)).body.run;
    expect(readbackEmptyText(s)).toBeNull();
    await env!.close();
    expect(readbackEmptyText(await check("claims-only", "PA-DRAFT-99413"))).toBe("No task for this outcome, so nothing was written or read back.");
  });
});
