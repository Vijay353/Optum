import { expect, test, type Page } from "@playwright/test";

async function loadScenario(page: Page, id: string) {
  const res = await page.request.post(`/api/scenarios/${id}/load`, { headers: { "x-demo-role": "pa-specialist" } });
  expect(res.ok()).toBeTruthy();
  await page.goto("/");
}

test("primary success: check → stage → verified task (keyboard-operable)", async ({ page }) => {
  await loadScenario(page, "primary-success");
  await expect(page.getByText("SYNTHETIC DATA ONLY")).toBeVisible();
  await expect(page.getByText("NO PAYER SUBMISSION")).toBeVisible();
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("External PT evidence found — review before submission");
  await expect(page.getByText("12 adjudicated PT service lines")).toBeVisible();
  await expect(page.getByText("Claims are leads, not proof of completion or outcome.")).toBeVisible();

  // Citation dialog shows the exact cited text
  await page.getByRole("button", { name: /View exact cited paragraph/ }).click();
  await expect(page.locator("mark").filter({ hasText: "Supervised therapy start date: 2026-01-12" })).toBeVisible();
  await page.keyboard.press("Escape");

  const stage = page.getByRole("button", { name: "Stage evidence review task" });
  await stage.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Task TASK-EVID-1042 staged and verified")).toBeVisible();
  await expect(page.getByText(/VERIFIED \(\d+\/\d+ checks\)/)).toBeVisible();

  await page.getByText("› Technical evidence").click();
  await expect(page.getByRole("cell", { name: "TOOL_CALL createEvidenceReviewTask" })).toBeVisible();

  const ws = await (await page.request.get("/api/workspace")).json();
  expect(ws.tasks).toHaveLength(1);
  expect(ws.draft.businessStatus).toBe("EVIDENCE_REVIEW_PENDING");
});

test("negative: opt-out stops retrieval and offers no task", async ({ page }) => {
  await loadScenario(page, "opt-out");
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("External retrieval not permitted");
  await expect(page.getByText("No claims or HIE documents were requested.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "No task for this outcome" })).toBeDisabled();
  const ws = await (await page.request.get("/api/workspace")).json();
  expect(ws.tasks).toHaveLength(0);
});

test("negative: read-only viewer cannot run or stage", async ({ page }) => {
  await loadScenario(page, "primary-success");
  await page.getByLabel("Demo identity").selectOption("viewer");
  await expect(page.getByRole("button", { name: "Run evidence check" })).toBeDisabled();
});

test("Excel import changes the next workflow decision", async ({ page }) => {
  await loadScenario(page, "primary-success");
  await page.getByRole("button", { name: "Data Studio" }).click();
  const csv = (await (await page.request.get("/api/data/export/patient_opt_out.csv")).text()).replace("SYN-PAT-1042,false", "SYN-PAT-1042,true");
  await page.getByLabel("Workbook file").setInputFiles({ name: "patient_opt_out.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Validate & preview" }).click();
  await page.getByRole("button", { name: /Commit 1 change/ }).click();
  await expect(page.getByText(/every committed row was read back unchanged/)).toBeVisible();
  await page.getByRole("button", { name: "Evidence review" }).click();
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("External retrieval not permitted");
});

test("mobile layout has no horizontal page scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadScenario(page, "primary-success");
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await expect(page.getByRole("button", { name: "Stage evidence review task" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("CH-0A: an opt-out recorded after the check stops staging", async ({ page }) => {
  await loadScenario(page, "primary-success");
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await expect(page.getByRole("button", { name: "Stage evidence review task" })).toBeVisible();
  await page.getByRole("button", { name: "Data Studio" }).click();
  const csv = (await (await page.request.get("/api/data/export/patient_opt_out.csv")).text()).replace("SYN-PAT-1042,false", "SYN-PAT-1042,true");
  await page.getByLabel("Workbook file").setInputFiles({ name: "patient_opt_out.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Validate & preview" }).click();
  await page.getByRole("button", { name: /Commit 1 change/ }).click();
  await page.getByRole("button", { name: "Evidence review" }).click();
  await page.getByRole("button", { name: "Stage evidence review task" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Staging stopped: access is no longer permitted");
  await expect(page.getByText("Final check stopped the write")).toBeVisible();
  const ws = await (await page.request.get("/api/workspace")).json();
  expect(ws.tasks).toHaveLength(0);
  expect(ws.draft.businessStatus).toBe("DRAFT_INCOMPLETE");
});

test("CH-0B: scenario time is shown and moving it forward blocks a stale check", async ({ page }) => {
  await loadScenario(page, "primary-success");
  await expect(page.getByText(/Scenario time: Oct 18, 2026/)).toBeVisible();
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await page.getByText("Demo controls").click();
  await page.getByRole("button", { name: "Move scenario time forward 25 hours" }).click();
  await expect(page.getByText(/moved forward 25 h for the demo/)).toBeVisible();
  await page.getByRole("button", { name: "Stage evidence review task" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This check is too old to act on");
  const ws = await (await page.request.get("/api/workspace")).json();
  expect(ws.tasks).toHaveLength(0);
});

test("CH-5: a staged review shows its due time, and later shows as overdue", async ({ page }) => {
  await loadScenario(page, "primary-success");
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await page.getByRole("button", { name: "Stage evidence review task" }).click();
  await expect(page.getByText(/Review due Oct 20, 2026/)).toBeVisible();
  await page.getByText("Demo controls").click();
  await page.getByRole("button", { name: "Move scenario time forward 25 hours" }).click();
  await page.getByRole("button", { name: "Move scenario time forward 25 hours" }).click();
  await expect(page.getByText(/Review overdue by 2 h\./)).toBeVisible();
  const ws = await (await page.request.get("/api/workspace")).json();
  expect(ws.tasks).toHaveLength(1);
});

test("CH-6: a second summary for the same period is flagged and nothing can be staged", async ({ page }) => {
  await loadScenario(page, "possible-duplicate-document");
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("More than one candidate document found");
  await expect(page.getByText("2 DOCUMENTS FOR THE SAME PERIOD")).toBeVisible();
  await expect(page.getByText(/This is often a normal amended copy/)).toBeVisible();
  await expect(page.getByRole("button", { name: "No task for this outcome" })).toBeDisabled();
  const ws = await (await page.request.get("/api/workspace")).json();
  expect(ws.tasks).toHaveLength(0);
});

test("CH-7: the staging projection is shown with zero write requests", async ({ page }) => {
  await loadScenario(page, "primary-success");
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await expect(page.getByRole("heading", { name: "What staging will do" })).toBeVisible();
  const writes: string[] = [];
  page.on("request", (r) => { if (r.method() !== "GET") writes.push(`${r.method()} ${r.url()}`); });
  await page.reload();
  await expect(page.getByText("Projection only. Nothing has changed yet.")).toBeVisible();
  await expect(page.getByText(/12 claim lead records, document HIE-PT-7781/)).toBeVisible();
  await expect(page.getByText(/Can be staged until/)).toBeVisible();
  expect(writes).toEqual([]);
  const ws = await (await page.request.get("/api/workspace")).json();
  expect(ws.tasks).toHaveLength(0);
});

test("CH-8: the clinic history line is shown and starts empty", async ({ page }) => {
  await loadScenario(page, "primary-success");
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await expect(page.getByText("EvidenceBridge history with this clinic (last 90 days, other drafts): no prior history.")).toBeVisible();
});

test("CH-10: count bars show billed lines and documented visits with printed numbers", async ({ page }) => {
  await loadScenario(page, "possible-duplicate-document");
  await page.getByRole("button", { name: "Run evidence check" }).click();
  const fig = page.getByRole("figure", { name: "Billed visit lines 12, documented visits 10" });
  await expect(fig).toBeVisible();
  await expect(fig.getByText("The summary documents 2 fewer visits than the claims bill. A person should check why.")).toBeVisible();
});

test("CH-11: earlier checks sit behind a keyboard-operable disclosure", async ({ page }) => {
  await loadScenario(page, "primary-success");
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await expect(page.getByText(/Showing check 1 of 1 for this draft/)).toBeVisible();
  await expect(page.getByText(/View earlier checks/)).toHaveCount(0);
  await page.getByRole("button", { name: "Stage evidence review task" }).click();
  await page.getByRole("button", { name: "Run the evidence check again" }).click();
  await expect(page.getByText(/Showing check 2 of 2 for this draft/)).toBeVisible();
  // The current check waits to be staged again, so earlier checks start open (rule: open when a response is needed).
  const earlier = page.getByText(/event evt-pa-99412-v3 · REVIEW_EXTERNAL_EVIDENCE · task staged and verified/);
  await expect(earlier).toBeVisible();
  const summary = page.getByText("View earlier checks (1)");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(earlier).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(earlier).toBeVisible();
});

test("CH-12: source-labelled badges use words, not color alone", async ({ page }) => {
  await loadScenario(page, "ambiguous-match");
  await page.getByRole("button", { name: "Run evidence check" }).click();
  const list = page.getByRole("list", { name: "Source statuses" });
  await expect(list.getByText("Index match:")).toContainText("Probable only");
  await expect(list.getByText("Patient match:")).toContainText("Ambiguous");
});

test("CH-13: a blocked viewer can switch demo role inline; the server still decides", async ({ page }) => {
  await loadScenario(page, "primary-success");
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await expect(page.getByRole("button", { name: "Stage evidence review task" })).toBeVisible();
  await page.getByLabel("Demo identity").selectOption("viewer");
  // The server refuses the viewer even if a request is forced.
  const forced = await page.request.post(`/api/runs/${(await (await page.request.get("/api/workspace")).json()).run.runId}/stage`, { headers: { "x-demo-role": "viewer" } });
  expect(forced.status()).toBe(403);
  await page.getByRole("button", { name: "Demo: switch to PA specialist" }).click();
  await expect(page.getByLabel("Demo identity")).toHaveValue("pa-specialist");
  await page.getByRole("button", { name: "Stage evidence review task" }).click();
  await expect(page.getByText("Task TASK-EVID-1042 staged and verified")).toBeVisible();
  await expect(page.getByRole("button", { name: "Demo: switch to PA specialist" })).toHaveCount(0);
});

test("CH-14: the stepper shows a stopped outcome in words", async ({ page }) => {
  await loadScenario(page, "opt-out");
  await expect(page.locator(".stepper li[aria-current=step]")).toContainText("Check draft");
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await expect(page.getByText("No task for this outcome", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".stepper li").nth(1)).toContainText("(stopped)");
  await expect(page.locator(".stepper li").nth(2)).toContainText("(skipped)");
});

test("CH-15: a search with no match says so and offers to clear it", async ({ page }) => {
  await loadScenario(page, "primary-success");
  await page.getByRole("button", { name: "Data Studio" }).click();
  await page.getByLabel("Entity", { exact: true }).selectOption("patients");
  await page.getByLabel("Search records").fill("zzz");
  await expect(page.getByText('No patients records match "zzz". 8 records exist without the search.')).toBeVisible();
  await page.getByRole("button", { name: "Clear the search" }).click();
  await expect(page.getByLabel("Search records")).toHaveValue("");
  await page.getByLabel("Entity", { exact: true }).selectOption("tasks");
  await expect(page.getByText(/No review tasks yet/)).toBeVisible();
});

test("CH-16: policy details open from the keyboard and state missing provenance", async ({ page }) => {
  await loadScenario(page, "primary-success");
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await page.getByText("About this policy version").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Provenance unavailable: the policy service does not record this")).toBeVisible();
  await expect(page.getByText("2026-10-01 to no end date")).toBeVisible();
});

test("CH-17: the audit chain can be verified from the inspector", async ({ page }) => {
  await loadScenario(page, "primary-success");
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await page.getByRole("button", { name: "Stage evidence review task" }).click();
  await expect(page.getByText("Task TASK-EVID-1042 staged and verified")).toBeVisible();
  await page.getByText("› Technical evidence").click();
  await page.getByRole("button", { name: "Verify audit chain" }).click();
  await expect(page.getByText(/ehr_audit: verified\./)).toBeVisible();
  await expect(page.getByText(/Not signed, not anchored outside this database/)).toBeVisible();
});

test("CH-19: the evidence check summary is near the decision and shows not-evaluated checks honestly", async ({ page }) => {
  await loadScenario(page, "opt-out");
  await page.getByRole("button", { name: "Run evidence check" }).click();
  const summary = page.locator(".evidence-checks summary");
  await expect(summary).toContainText("did not pass");
  await summary.click();
  const row = page.getByRole("row", { name: /Document hash matches/ });
  await expect(row).toContainText("Not evaluated");
  await expect(page.getByRole("row", { name: /Provider Access permitted/ })).toContainText("Did not pass");
});

test("CH-18: the audit evidence package downloads as JSON with an honest status", async ({ page }) => {
  await loadScenario(page, "primary-success");
  await page.getByRole("button", { name: "Run evidence check" }).click();
  await page.getByRole("button", { name: "Stage evidence review task" }).click();
  await expect(page.getByText("Task TASK-EVID-1042 staged and verified")).toBeVisible();
  await page.getByText("› Technical evidence").click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export audit evidence package (JSON)" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^evidence-package-[A-Za-z0-9-]+\.json$/);
  await expect(page.getByRole("status").filter({ hasText: "Evidence status:" })).toContainText("Complete");
  const body = JSON.parse(await (await import("node:fs/promises")).readFile((await file.path())!, "utf8")) as { evidenceStatus: string; digest: { algorithm: string } };
  expect(body.evidenceStatus).toBe("complete");
  expect(body.digest.algorithm).toBe("sha256");
});
