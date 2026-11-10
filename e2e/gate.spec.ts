/** V3 CH-20 browser checks against a server with the access gate on (see playwright.config.ts). */
import { expect, test } from "@playwright/test";

const GATE = "http://127.0.0.1:8798";
test.use({ baseURL: GATE });

test("CH-20: a deep link shows the gate first, which loads nothing from anywhere else", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto("/review/PA-DRAFT-99412?from=email");
  await expect(page).toHaveURL(/\/gate\?next=/);
  await expect(page.getByLabel("Passcode")).toBeFocused();
  await expect(page.getByRole("button", { name: "Enter EvidenceBridge" })).toBeVisible();
  expect(requests.every((u) => u.startsWith(GATE))).toBe(true);
  expect(requests.filter((u) => !/\/(review|gate)/.test(new URL(u).pathname))).toEqual([]); // no scripts, styles, fonts or beacons
});

test("CH-20: wrong passcode shows a plain error; right one opens the deep link; lock returns to the gate", async ({ page }) => {
  await page.goto("/review/PA-DRAFT-99412");
  await page.getByLabel("Passcode").fill("1357");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toHaveText("That passcode did not work. Check it and try again.");
  await expect(page.getByLabel("Passcode")).toHaveAttribute("aria-invalid", "true");
  await expect(page).toHaveURL(/\/gate/);

  await page.getByLabel("Passcode").fill("24-68"); // paste with a separator: digits only are kept
  await expect(page.getByLabel("Passcode")).toHaveValue("2468");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${GATE}/review/PA-DRAFT-99412`);
  // The app shell, whatever state the shared demo database is in.
  await expect(page.getByRole("button", { name: "Evidence review", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Evidence review", exact: true })).toBeVisible();
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === "eb_access")).toMatchObject({ httpOnly: true, sameSite: "Lax" });

  await page.getByRole("button", { name: "Lock demo" }).click();
  await expect(page).toHaveURL(`${GATE}/gate`);
  await page.goto("/");
  await expect(page).toHaveURL(/\/gate\?next=%2F$/);
});

test("CH-20: an expired session sends the app back to the gate, keeping the place", async ({ page }) => {
  await page.goto("/gate");
  await page.getByLabel("Passcode").fill("2468");
  await page.getByRole("button", { name: "Enter EvidenceBridge" }).click();
  await expect(page.getByRole("region", { name: "Demo scenario" })).toBeVisible(); // first data load finished
  await page.waitForLoadState("networkidle");
  await page.context().clearCookies(); // same effect as expiry: the server no longer sees a valid session
  await page.getByRole("button", { name: "Data Studio" }).click(); // its first API call meets the expired session
  await expect(page).toHaveURL(/\/gate\?next=%2F/);
});

test("CH-20: gate layout fits a phone screen and works from the keyboard", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 700 } });
  const page = await ctx.newPage();
  await page.goto(`${GATE}/gate`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByLabel("Passcode")).toBeFocused();
  await page.keyboard.type("2468");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Enter EvidenceBridge" })).toBeFocused();
  await page.screenshot({ path: "test-results/gate-mobile.png" });
  await ctx.close();
});
