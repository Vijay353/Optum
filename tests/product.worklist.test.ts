/**
 * Product P3: the worklist route is read-only composition, and the queue
 * mapper turns every recorded run status into a plain status without deciding
 * anything. "Check all" semantics are covered by calling the same /check
 * route per unchecked draft, exactly as the browser does.
 */
import { afterEach, describe, expect, it } from "vitest";
import { api, countRows, startTestServer, type TestEnv } from "./helpers";
import { RUN_STATUSES, type Run } from "../src/orchestrator/runTypes";
import type { WorklistItem } from "../src/server/worklist";
import { defaultSelection, groupCounts, queueStatus, sortQueue, uncheckedDrafts } from "../src/ui/worklist";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

const item = (draftId: string, latest: WorklistItem["latest"], scenarioDraft = false): WorklistItem => ({
  draftId, version: 1, businessStatus: "DRAFT_INCOMPLETE", patientId: "SYN-PAT-1", ageBand: "55-64", service: "x", policyVersion: "p", updatedAt: "t", scenarioDraft, checks: latest ? 1 : 0, latest,
});
const latest = (status: string, outcomeState: string | null = null, refusal: string | null = null, decision: string | null = "X"): WorklistItem["latest"] => ({ runId: "r", status, decision, outcomeState, createdAt: "2026-10-18T13:10:00Z", refusal });

describe("queue mapper (pure)", () => {
  it("maps every run status to a worded status, never an unknown fallback", () => {
    for (const s of RUN_STATUSES) {
      const st = queueStatus(item("D", latest(s, "MANUAL_REVIEW")));
      expect(st.label.length, s).toBeGreaterThan(3);
      expect(st.label).not.toMatch(/[A-Z]{3,}_/); // no status codes in labels
      expect(st.hint).not.toBe("Unknown status");
    }
  });
  it("puts work that needs a person first, unchecked next, dead ends and done last", () => {
    const items = [
      item("A", latest("COMPLETED", "EVIDENCE_REVIEW_PENDING")),
      item("B", null),
      item("C", latest("NO_ACTION", "ACCESS_NOT_PERMITTED")),
      item("D", latest("AWAITING_CONFIRMATION", "EVIDENCE_REVIEW_PENDING")),
      item("E", latest("NO_ACTION", "CLAIM_SOURCE_FOLLOWUP")),
    ];
    expect(sortQueue(items).map((i) => i.draftId)).toEqual(["D", "E", "B", "C", "A"]);
    expect(groupCounts(items)).toEqual({ "needs-you": 2, "not-checked": 1, "no-action": 1, done: 1 });
    expect(defaultSelection(items)).toBe("D");
  });
  it("a refused write reads as 'check again', not as a dead end", () => {
    expect(queueStatus(item("A", latest("NO_ACTION", "EVIDENCE_REVIEW_PENDING", "RUN_TOO_OLD"))).key).toBe("recheck");
  });
  it("ties are broken by the scenario's draft, then by id; bulk check only targets unchecked drafts", () => {
    const items = [item("B", null), item("C", null, true), item("A", latest("NO_ACTION", "ACCESS_NOT_PERMITTED"))];
    expect(defaultSelection(items)).toBe("C");
    expect(uncheckedDrafts(items)).toEqual(["B", "C"]);
  });
});

describe("GET /api/worklist (read-only composition)", () => {
  it("lists every draft with its latest check, and writes nothing", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const before = { runs: countRows(env.db, "app_runs"), audit: countRows(env.db, "app_audit"), ehrAudit: countRows(env.db, "ehr_audit") };
    const wl = (await api<{ items: WorklistItem[] }>(env, "GET", "/api/worklist")).body.items;
    expect(wl).toHaveLength(8);
    expect(wl.filter((i) => i.scenarioDraft).map((i) => i.draftId)).toEqual(["PA-DRAFT-99412"]);
    expect(wl.every((i) => i.latest === null && i.checks === 0)).toBe(true);
    expect({ runs: countRows(env.db, "app_runs"), audit: countRows(env.db, "app_audit"), ehrAudit: countRows(env.db, "ehr_audit") }).toEqual(before);
    for (const m of ["POST", "PUT", "DELETE"]) expect((await fetch(`${env.baseUrl}/api/worklist`, { method: m, headers: { "x-demo-role": "pa-specialist" } })).status).toBe(404);
  });

  it("bulk check (one /check per unchecked draft) triages the queue and never stages a task", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const first = (await api<{ items: WorklistItem[] }>(env, "GET", "/api/worklist")).body.items;
    for (const id of uncheckedDrafts(first)) expect((await api<{ run: Run }>(env, "POST", `/api/drafts/${id}/check`)).status).toBe(200);
    const after = (await api<{ items: WorklistItem[] }>(env, "GET", "/api/worklist")).body.items;
    expect(countRows(env.db, "ehr_tasks")).toBe(0);
    expect(after.every((i) => i.businessStatus === "DRAFT_INCOMPLETE")).toBe(true);
    const keys = Object.fromEntries(after.map((i) => [i.draftId, queueStatus(i).key]));
    expect(keys).toEqual({
      "PA-DRAFT-99412": "ready", "PA-DRAFT-99413": "records", "PA-DRAFT-99414": "no-access", "PA-DRAFT-99415": "person",
      "PA-DRAFT-99416": "no-access", "PA-DRAFT-99417": "person", "PA-DRAFT-99418": "ready", "PA-DRAFT-99419": "recheck",
    });
    expect(uncheckedDrafts(after)).toEqual([]);
    expect(defaultSelection(after)).toBe("PA-DRAFT-99412");
  });

  it("a viewer can read the queue but cannot run a check", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    expect((await api(env, "GET", "/api/worklist", undefined, "viewer")).status).toBe(200);
    expect((await api(env, "POST", "/api/drafts/PA-DRAFT-99413/check", undefined, "viewer")).status).toBe(403);
  });
});
