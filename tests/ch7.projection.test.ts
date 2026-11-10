/** V3 CH-7: read-only staging projection (pure, client-side). */
import { afterEach, describe, expect, it } from "vitest";
import { api, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";
import { projectStaging } from "../src/ui/projection";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

async function evaluated(): Promise<{ run: Run; maxRunAgeHours: number }> {
  env = await startTestServer({ scenario: "primary-success" });
  await api(env, "POST", "/api/drafts/PA-DRAFT-99412/check");
  const ws = (await api<{ run: Run; limits: { maxRunAgeHours: number } }>(env, "GET", "/api/workspace")).body;
  return { run: ws.run, maxRunAgeHours: ws.limits.maxRunAgeHours };
}

describe("projectStaging", () => {
  it("restates the staged input exactly, with no invented values", async () => {
    const { run, maxRunAgeHours } = await evaluated();
    const p = projectStaging(run, maxRunAgeHours)!;
    const input = run.stagedToolInput!;
    expect(p).toMatchObject({
      taskEffect: "CREATE", owner: "PA specialist queue", dueAt: input.dueAt, draftId: "PA-DRAFT-99412",
      fromStatus: "DRAFT_INCOMPLETE", toStatus: "EVIDENCE_REVIEW_PENDING", draftVersion: 3, claimLeadCount: 12,
      evidenceDocumentId: "HIE-PT-7781", evidenceHashShort: input.evidenceDocumentHash.slice(0, 12), policyVersion: "SYN-SPINE-PA-2026-10",
    });
    expect(Date.parse(p.stageableUntil!) - Date.parse(run.createdAt)).toBe(24 * 3600_000);
    expect(p.unchanged.join(" ")).toMatch(/Payer \(nothing is submitted\)/);
  });

  it("says create-or-replay after a failed attempt, and nothing once done or refused", async () => {
    const { run } = await evaluated();
    expect(projectStaging({ ...run, status: "FAILED_RETRYABLE" }, 24)?.taskEffect).toBe("CREATE_OR_REPLAY");
    for (const status of ["COMPLETED", "NO_ACTION", "REEVALUATION_REQUIRED", "FAILED", "EXECUTING"] as const) {
      expect(projectStaging({ ...run, status }, 24), status).toBeNull();
    }
    expect(projectStaging({ ...run, stagedToolInput: null }, 24)).toBeNull();
  });

  it("leaves the deadline out rather than guessing when the limit or time is unknown", async () => {
    const { run } = await evaluated();
    expect(projectStaging(run, null)?.stageableUntil).toBeNull();
    expect(projectStaging({ ...run, createdAt: "not a time" }, 24)?.stageableUntil).toBeNull();
  });

  it("is pure: same input, same output, input not modified", async () => {
    const { run } = await evaluated();
    const before = JSON.stringify(run);
    expect(projectStaging(run, 24)).toEqual(projectStaging(run, 24));
    expect(JSON.stringify(run)).toBe(before);
  });
});
