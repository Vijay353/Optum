/**
 * Product P4: "Why this decision" and the plain-language copy deck.
 * - Every block comes from a server check that exists; none is invented.
 * - Record references, hashes and rule ids never reach Layer 0/1 text.
 * - The copy deck contains none of the banned technical terms.
 */
import { afterEach, describe, expect, it } from "vitest";
import { api, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";
import type { EvidenceCheck } from "../src/orchestrator/evidenceChecks";
import { listScenarios } from "../src/server/scenarios";
import { whyView } from "../src/ui/why";
import { BANNED_TERMS, DECISION_WORDS, LAYER_01_COPY, decisionWords } from "../src/ui/copy";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (typeof v === "function") return [];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}

describe("copy deck (spec CH-1.4 banned-term lint)", () => {
  it("has no technical terms in any Layer 0/1 string", () => {
    const all = strings(LAYER_01_COPY);
    expect(all.length).toBeGreaterThan(50);
    for (const s of all) for (const re of BANNED_TERMS) expect(re.test(s), `"${s}" matches ${re}`).toBe(false);
  });
  it("has words for every policy decision and a safe fallback", () => {
    for (const d of ["REVIEW_EXTERNAL_EVIDENCE", "CLAIM_LEAD_ONLY", "ACCESS_NOT_PERMITTED", "SOURCE_UNAVAILABLE", "MANUAL_REVIEW", "INSUFFICIENT_EVIDENCE"]) expect(DECISION_WORDS[d]).toBeTruthy();
    expect(decisionWords("SOMETHING_NEW")).toBe(DECISION_WORDS.NO_DECISION);
  });
});

describe.each(listScenarios().map((s) => [s.id, s] as const))("why view: %s", (_id, sc) => {
  it("is built only from recorded checks and policy reasons, with no technical references", async () => {
    env = await startTestServer({ scenario: sc.id });
    const checked = (await api<{ run: Run }>(env, "POST", `/api/drafts/${sc.draftId}/check`)).body.run;
    if (checked.status === "AWAITING_CONFIRMATION") await api(env, "POST", `/api/runs/${checked.runId}/stage`);
    const ws = (await api<{ run: Run; evidenceChecks: EvidenceCheck[] }>(env, "GET", "/api/workspace")).body;
    const v = whyView(ws.run, ws.evidenceChecks)!;
    const ids = new Set(ws.evidenceChecks.map((c) => c.checkId));
    for (const b of v.blocks) {
      expect(ids.has(b.id), b.id).toBe(true);
      const c = ws.evidenceChecks.find((x) => x.checkId === b.id)!;
      expect(b.status).toBe(c.status);
      expect(b.answer).toBe(c.detail);
      for (const ref of c.evidenceRefs) expect(b.answer.includes(ref), ref).toBe(false);
    }
    expect(v.reasons).toEqual(ws.run.policyResult?.reasons ?? (ws.run.error ? [ws.run.error] : []));
    for (const s of [v.decision, ...v.blocks.map((b) => b.question)]) for (const re of BANNED_TERMS) expect(re.test(s), s).toBe(false);
    // A check that never ran never reads as passed.
    for (const b of v.blocks) if (ws.evidenceChecks.find((c) => c.checkId === b.id)!.status === "NOT_EVALUATED") expect(b.status).toBe("NOT_EVALUATED");
  });
});

it("why view is empty without a run", () => {
  expect(whyView(null, [])).toBeNull();
});
