/**
 * V3 CH-21 browser checks on the gate-on server. Requests to clarity.ms are answered by a local stub,
 * so nothing reaches a real analytics project. The stub reports every Clarity call back to the test.
 */
import { expect, test, type Page } from "@playwright/test";

const GATE = "http://127.0.0.1:8798";
test.use({ baseURL: GATE });
const STUB = `(function(){var q=(window.clarity&&window.clarity.q)||[];function rep(a){try{window.__report(JSON.stringify(a))}catch(e){}}q.forEach(rep);window.clarity=function(){rep(Array.prototype.slice.call(arguments))};})();`;
const APPROVED = ["project_entered", "scenario_started", "evidence_check_run", "scenario_completed", "audit_export_clicked"];

async function instrument(page: Page) {
  const tagRequests: string[] = [];
  const otherThirdParty: string[] = [];
  const calls: unknown[][] = [];
  await page.exposeBinding("__report", (_s, a: string) => void calls.push(JSON.parse(a) as unknown[]));
  await page.route("https://www.clarity.ms/**", (r) => { tagRequests.push(r.request().url()); return r.fulfill({ contentType: "text/javascript", body: STUB }); });
  page.on("request", (r) => { if (!r.url().startsWith(GATE) && !r.url().startsWith("https://www.clarity.ms/")) otherThirdParty.push(r.url()); });
  return { tagRequests, otherThirdParty, calls };
}

test("CH-21: nothing on the gate; nothing before Allow; one load after; only approved event names, no ids", async ({ page }) => {
  const t = await instrument(page);
  await page.goto("/");
  await page.getByLabel("Passcode").fill("1111");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  expect(t.tagRequests).toEqual([]); // gate screen and a wrong PIN: zero analytics requests

  await page.getByLabel("Passcode").fill("2468");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Demo scenario" })).toBeVisible();
  // Start from the seeded scenario whatever an earlier test left behind (API call: not an analytics action).
  expect((await page.request.post("/api/scenarios/primary-success/load", { headers: { "x-demo-role": "pa-specialist" } })).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "Run evidence check" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Analytics choice" })).toBeVisible();
  expect(t.tagRequests).toEqual([]); // entered, but no choice yet
  await expect(page.locator("main#main")).toHaveAttribute("data-clarity-mask", "true");

  await page.getByRole("button", { name: "Allow analytics" }).click();
  await expect.poll(() => t.tagRequests).toEqual([`https://www.clarity.ms/tag/ebtest01`]);
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await expect(page.getByRole("button", { name: "Stage evidence review task" })).toBeVisible();
  await page.getByRole("button", { name: "Data Studio" }).click();
  await page.getByRole("button", { name: "Evidence review", exact: true }).click();
  await expect.poll(() => t.calls.filter((c) => c[0] === "event").map((c) => c[1])).toEqual(["project_entered", "evidence_check_run"]);
  expect(t.tagRequests).toHaveLength(1); // tab changes do not reinstall

  expect(t.calls[0]).toEqual(["consentv2", { ad_Storage: "denied", analytics_Storage: "granted" }]);
  for (const c of t.calls.filter((x) => x[0] === "event")) expect(APPROVED).toContain(c[1]);
  expect(JSON.stringify(t.calls)).not.toMatch(/PA-DRAFT|SYN-|RUN-|TASK-|2468|pa-specialist/);
  expect(t.otherThirdParty).toEqual([]);

  await page.reload();
  await expect(page.getByRole("button", { name: "Stage evidence review task" })).toBeVisible();
  await expect.poll(() => t.tagRequests).toHaveLength(2); // once per page load
  expect(t.calls.filter((c) => c[1] === "project_entered")).toHaveLength(1); // not again on reload
});

test("CH-21: No thanks loads nothing; turning analytics off clears Clarity cookies and unloads it", async ({ page }) => {
  const t = await instrument(page);
  await page.goto("/gate");
  await page.getByLabel("Passcode").fill("2468");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "No thanks" }).click();
  await expect(page.getByRole("region", { name: "Analytics choice" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Analytics off")).toBeVisible();
  expect(t.tagRequests).toEqual([]);

  await page.getByRole("button", { name: "Turn on analytics" }).click();
  await expect.poll(() => t.tagRequests).toHaveLength(1);
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Turn off analytics" }).click()]);
  expect(t.calls).toContainEqual(["consentv2", { ad_Storage: "denied", analytics_Storage: "denied" }]);
  expect(t.calls).toContainEqual(["consent", false]);
  await expect(page.getByText("Analytics off")).toBeVisible();
  expect(t.tagRequests).toHaveLength(1); // nothing reloaded after withdrawal
});
