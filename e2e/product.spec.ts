/**
 * Product enhancement (docs/PRODUCT-ENHANCEMENT-PLAN.md) browser checks.
 * Every write still goes through POST /api/runs/:id/stage; these tests also
 * prove the new surfaces do not write on their own.
 */
import { expect, test, type Page } from "@playwright/test";

async function loadScenario(page: Page, id: string, path = "/") {
  const res = await page.request.post(`/api/scenarios/${id}/load`, { headers: { "x-demo-role": "pa-specialist" } });
  expect(res.ok()).toBeTruthy();
  await page.goto(path);
}
const nonGet = (page: Page) => {
  const writes: string[] = [];
  page.on("request", (r) => { if (r.method() !== "GET") writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  return writes;
};

test("P3: the worklist shows every draft; Check all triages the queue without creating a task", async ({ page }) => {
  await loadScenario(page, "primary-success");
  const list = page.getByRole("navigation", { name: "Drafts to work" });
  await expect(list.getByRole("button", { name: /^Draft 994/ })).toHaveCount(8);
  await expect(list.getByRole("region", { name: "Not checked yet: 8" })).toBeVisible();
  const writes = nonGet(page);
  await list.getByRole("button", { name: "Check all waiting drafts (8)" }).click();
  await expect(list.getByRole("button", { name: "All drafts checked" })).toBeDisabled({ timeout: 20_000 });
  expect(writes.filter((w) => !/^POST \/api\/drafts\/PA-DRAFT-\d+\/check$/.test(w))).toEqual([]);
  expect(writes).toHaveLength(8);
  await expect(list.getByRole("region", { name: /^Needs you: 6$/ })).toBeVisible();
  await expect(list.getByRole("region", { name: /^No action possible: 2$/ })).toBeVisible();
  await expect(list.getByTestId("queue-PA-DRAFT-99412")).toContainText("Evidence ready for you");
  await list.getByTestId("queue-PA-DRAFT-99413").click();
  await expect(list.getByTestId("queue-PA-DRAFT-99413")).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Claim leads found — no clinical document yet");
  const ws = await (await page.request.get("/api/workspace?draftId=PA-DRAFT-99412")).json();
  expect(ws.tasks).toHaveLength(0);
});

test("P5: the confirmation sheet restates the effect; Cancel and Escape write nothing", async ({ page }) => {
  await loadScenario(page, "primary-success");
  await page.getByRole("button", { name: "Run evidence check" }).click();
  const writes = nonGet(page);
  const stage = page.getByRole("button", { name: "Stage evidence review task" });
  await stage.click();
  const sheet = page.getByRole("dialog", { name: "Create the review task?" });
  await expect(sheet).toContainText("Change the clinical chart");
  await expect(sheet).toContainText("Send anything to the payer");
  await expect(sheet).toContainText("Incomplete: a record is missing");
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toHaveCount(0);
  await stage.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(writes).toEqual([]);
  const ws = await (await page.request.get("/api/workspace")).json();
  expect(ws.tasks).toHaveLength(0);
});

test("P8: the printable evidence summary is built from the run and is the only thing printed", async ({ page }) => {
  await loadScenario(page, "primary-success");
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await page.getByRole("button", { name: "Stage evidence review task" }).click();
  await page.getByRole("button", { name: "Yes, create the review task" }).click();
  await expect(page.getByText("Task TASK-EVID-1042 staged and verified")).toBeVisible();
  await page.getByRole("button", { name: "Print evidence summary" }).click();
  const doc = page.getByTestId("evidence-packet");
  await expect(doc).toContainText("Evidence summary for review");
  await expect(doc).toContainText("PA-DRAFT-99412");
  await expect(doc).toContainText(/Completeness: \d+ passed/);
  await expect(doc).toContainText("Supervised therapy start date: 2026-01-12");
  await expect(doc).toContainText(/Verified: 16 of 16 fields matched/);
  await expect(doc).toContainText("Not an official Optum product");
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#root")).toBeHidden();
  await expect(doc).toBeVisible();
  await page.emulateMedia({ media: "screen" });
  await page.getByRole("button", { name: "Close" }).click();
  await expect(doc).toHaveCount(0);
});

test("P9: metrics reflect exactly the recorded runs; the estimate is labelled and editable", async ({ page }) => {
  await loadScenario(page, "primary-success");
  await page.getByRole("button", { name: "Metrics" }).click();
  await expect(page.getByText(/No checks yet/)).toBeVisible();
  await page.getByRole("button", { name: "Evidence review", exact: true }).click();
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await expect(page.getByRole("button", { name: "Stage evidence review task" })).toBeVisible();
  await page.getByRole("button", { name: "Metrics" }).click();
  const tiles = page.getByRole("region", { name: "Observed counts" });
  await expect(tiles.getByRole("article").filter({ hasText: "Drafts checked before submission" })).toContainText("1");
  await expect(tiles.getByRole("article").filter({ hasText: "Checks run in total" })).toContainText("1");
  await expect(page.getByText("ESTIMATE", { exact: true })).toBeVisible();
  await expect(page.getByText("1 draft with outside evidence found × 35 min per manual records chase = 35 min")).toBeVisible();
  await page.getByLabel(/Minutes a manual records chase takes/).fill("60");
  await expect(page.getByText("1 draft with outside evidence found × 60 min per manual records chase = 60 min")).toBeVisible();
});

test("P10: pitch mode hides the lab and drives the tour from real state", async ({ page }) => {
  await loadScenario(page, "primary-success", "/?mode=pitch");
  await expect(page.getByRole("region", { name: "Guided tour" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Demo scenario" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Data Studio" })).toHaveCount(0);
  await expect(page.getByLabel("Demo identity")).toHaveCount(0);
  await expect(page.getByText("Acting as PA specialist")).toBeVisible();
  await page.getByRole("button", { name: /Check all waiting drafts/ }).click();
  await expect(page.getByRole("button", { name: "All drafts checked" })).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("queue-PA-DRAFT-99418").click();
  await page.getByRole("button", { name: "Stage evidence review task" }).click();
  await page.getByRole("button", { name: "Yes, create the review task" }).click();
  await expect(page.getByText(/staged and verified/).first()).toBeVisible();
  await page.getByRole("button", { name: "Print evidence summary" }).click();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("Tour complete. Everything shown came from real checks on this server.")).toBeVisible();
  await page.goto("/?mode=demo");
  await expect(page.getByRole("region", { name: "Demo scenario" })).toBeVisible();
});

test("P2: senior-readable defaults — 17 px body, 44 px targets, skip link, primary action above the fold", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loadScenario(page, "primary-success");
  await expect(page.getByRole("button", { name: "Run evidence check" })).toBeVisible();
  // The first Tab stop on a fresh page is the skip link; Enter moves focus to the main region.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
  await page.getByRole("button", { name: "Run evidence check" }).click();
  const stage = page.getByRole("button", { name: "Stage evidence review task" });
  await expect(stage).toBeInViewport();
  expect(await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize))).toBeGreaterThanOrEqual(17);
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, select, input, summary, a.btn")]
      .filter((el) => el.offsetParent !== null && !el.closest(".sr-only"))
      .map((el) => ({ t: (el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 40), h: el.getBoundingClientRect().height }))
      .filter((x) => x.h < 44),
  );
  expect(small).toEqual([]);
});

test("P11: no horizontal scroll at 390 px for any scenario", async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  const { scenarios } = await (await page.request.get("/api/scenarios")).json();
  for (const sc of scenarios as Array<{ id: string }>) {
    await loadScenario(page, sc.id);
    await page.getByRole("button", { name: "Run evidence check" }).click();
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("Prior-authorization draft is waiting for an evidence check", { timeout: 15_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, sc.id).toBeLessThanOrEqual(0);
  }
});
