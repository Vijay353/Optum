/** V3 CH-12: source-labelled badges; external and own checks never merged; unknown is not zero. */
import { afterEach, describe, expect, it } from "vitest";
import { api, startTestServer, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";
import { statusBadges } from "../src/ui/badges";

let env: TestEnv | undefined;
afterEach(async () => { await env?.close(); env = undefined; });
const run = async (scenario: string, draft: string) => {
  env = await startTestServer({ scenario });
  return (await api<{ run: Run }>(env, "POST", `/api/drafts/${draft}/check`)).body.run;
};
const view = (r: Run) => statusBadges(r).map((b) => `${b.source}|${b.label}|${b.value}|${b.tone}`);

describe("statusBadges", () => {
  it("primary: four separate badges from three sources", async () => {
    expect(view(await run("primary-success", "PA-DRAFT-99412"))).toEqual([
      "Payer (Provider Access)|Access|Permitted|ok", "HIE|Index match|Exact|ok",
      "EvidenceBridge check|Patient match|Exact|ok", "EvidenceBridge check|Document hash|Verified|ok",
    ]);
  });
  it("opt-out: access not permitted, everything else unknown or not evaluated", async () => {
    expect(view(await run("opt-out", "PA-DRAFT-99414"))).toEqual([
      "Payer (Provider Access)|Access|Not permitted|bad", "HIE|Index match|Unknown|unknown",
      "EvidenceBridge check|Patient match|Not evaluated|unknown", "EvidenceBridge check|Document hash|Not evaluated|unknown",
    ]);
  });
  it("ambiguous: HIE says probable while our own check says ambiguous (two badges, two sources)", async () => {
    const v = view(await run("ambiguous-match", "PA-DRAFT-99415"));
    expect(v).toContain("HIE|Index match|Probable only|warn");
    expect(v).toContain("EvidenceBridge check|Patient match|Ambiguous|warn");
  });
  it("superseded policy: access was never checked, which is not the same as denied", async () => {
    expect(view(await run("policy-superseded", "PA-DRAFT-99419"))[0]).toBe("Payer (Provider Access)|Access|Not checked|unknown");
  });
  it("hash mismatch is shown as a mismatch", async () => {
    expect(view(await run("hash-mismatch", "PA-DRAFT-99412"))).toContain("EvidenceBridge check|Document hash|Mismatch|bad");
  });
});
