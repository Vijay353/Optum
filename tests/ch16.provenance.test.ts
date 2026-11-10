/** V3 CH-16: policy provenance shows only persisted facts; missing ones are stated, not invented. */
import { afterEach, describe, expect, it } from "vitest";
import { api, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";
import { policyProvenance } from "../src/ui/provenance";
import { loadFixtureDataset } from "../src/data/datasetStore";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });

describe("policyProvenance", () => {
  it("matches the policy actually stored, including its real checklist size", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const run = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    const stored = loadFixtureDataset("fixtures/base").dataset.policy_requirements.find((p) => p.policyVersion === "SYN-SPINE-PA-2026-10")!;
    const rows = Object.fromEntries(policyProvenance(run)!.map((r) => [r.label, r.value]));
    expect(rows).toEqual({
      "Policy version": "SYN-SPINE-PA-2026-10 (active)",
      Effective: "2026-10-01 to no end date",
      "Checklist items in this version": String(stored.requirements.length),
      "Lookback for this item": "12 months",
      "Decision rules": "EVID-1.1",
      "Last changed by and when": "Provenance unavailable: the policy service does not record this",
    });
    expect(stored.requirements.length).toBe(2);
  });
  it("a run from before CH-16 shows not recorded instead of guessing", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const run = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    const legacy = { ...run, context: { ...run.context!, policy: { policyVersion: "SYN-SPINE-PA-2026-10", status: "active", label: "SYNTHETIC", lookbackMonths: 12 } } };
    const rows = Object.fromEntries(policyProvenance(legacy)!.map((r) => [r.label, r.value]));
    expect(rows.Effective).toBe("Not recorded for this check");
    expect(rows["Checklist items in this version"]).toBe("Not recorded for this check");
  });
  it("no context, no provenance block", async () => {
    env = await startTestServer({ scenario: "primary-success" });
    const run = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    expect(policyProvenance({ ...run, context: null })).toBeNull();
  });
});
