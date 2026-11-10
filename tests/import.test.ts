/** Data Studio import/export (G3): schema, data quality, formula safety, idempotency, stale revisions, restore. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { countRows, startTestServer, api, type TestEnv } from "./helpers";
import type { Run } from "../src/orchestrator/runTypes";

let env: TestEnv;
beforeEach(async () => { env = await startTestServer({ scenario: "primary-success" }); });
afterEach(async () => { await env.close(); });

type Preview = { batchId: string | null; canCommit: boolean; issues: Array<{ sheet: string; row: number | null; column: string | null; message: string }>; diff: Record<string, { added: number; updated: number; unchanged: number; rejected: number; removed: number }> };

async function upload(buf: Buffer, filename: string, mode: "merge" | "replace" = "merge", role = "pa-specialist") {
  const res = await fetch(`${env.baseUrl}/api/data/import/preview?filename=${encodeURIComponent(filename)}&mode=${mode}`, {
    method: "POST", headers: { "content-type": "application/octet-stream", "x-demo-role": role }, body: new Uint8Array(buf),
  });
  return { status: res.status, body: (await res.json()) as Preview };
}
const template = () => readFileSync("data/templates/evidencebridge-template.xlsx");
async function editTemplate(fn: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(template() as unknown as ArrayBuffer);
  fn(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
function setCell(wb: ExcelJS.Workbook, sheet: string, col: string, matchCol: string, matchVal: string, value: ExcelJS.CellValue) {
  const ws = wb.getWorksheet(sheet)!;
  const idx: Record<string, number> = {};
  ws.getRow(1).eachCell((c, i) => { idx[String(c.value)] = i; });
  ws.eachRow((row, n) => { if (n > 1 && row.getCell(idx[matchCol]!).value === matchVal) row.getCell(idx[col]!).value = value; });
}

describe("XLSX import", () => {
  it("re-importing the template into the same data is idempotent (all unchanged, nothing to commit)", async () => {
    const r = await upload(template(), "evidencebridge-template.xlsx");
    expect(r.status).toBe(200);
    expect(r.body.issues).toEqual([]);
    expect(r.body.canCommit).toBe(false);
    expect(r.body.diff.patients).toEqual({ added: 0, updated: 0, unchanged: 8, rejected: 0, removed: 0 });
  });

  it("an edited workbook changes simulator state and the next workflow decision (opt-out flips to true)", async () => {
    const buf = await editTemplate((wb) => setCell(wb, "patient_opt_out", "optedOut", "patientId", "SYN-PAT-1042", true));
    const p = await upload(buf, "edited.xlsx");
    expect(p.body.canCommit).toBe(true);
    expect(p.body.diff.patient_opt_out).toMatchObject({ updated: 1, unchanged: 7 });
    // Preview alone does not mutate
    expect((env.db.prepare("SELECT opted_out FROM payer_opt_out WHERE patient_id='SYN-PAT-1042'").get() as { opted_out: number }).opted_out).toBe(0);
    const c = await api<{ verified: boolean }>(env, "POST", `/api/data/import/${p.body.batchId}/commit`);
    expect(c.status).toBe(200);
    expect(c.body.verified).toBe(true);
    expect((env.db.prepare("SELECT opted_out FROM payer_opt_out WHERE patient_id='SYN-PAT-1042'").get() as { opted_out: number }).opted_out).toBe(1);
    const run = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    expect(run.policyResult?.decision).toBe("ACCESS_NOT_PERMITTED");
    // A committed batch cannot be committed twice
    expect((await api(env, "POST", `/api/data/import/${p.body.batchId}/commit`)).status).toBe(409);
  });

  it("restore returns the simulators to the pre-import snapshot", async () => {
    const buf = await editTemplate((wb) => setCell(wb, "patient_opt_out", "optedOut", "patientId", "SYN-PAT-1042", true));
    const p = await upload(buf, "edited.xlsx");
    await api(env, "POST", `/api/data/import/${p.body.batchId}/commit`);
    const r = await api(env, "POST", `/api/data/imports/${p.body.batchId}/restore`);
    expect(r.status).toBe(200);
    expect((env.db.prepare("SELECT opted_out FROM payer_opt_out WHERE patient_id='SYN-PAT-1042'").get() as { opted_out: number }).opted_out).toBe(0);
    const hist = await api<{ batches: Array<{ id: string; status: string }> }>(env, "GET", "/api/data/imports");
    expect(hist.body.batches.find((b) => b.id === p.body.batchId)?.status).toBe("RESTORED");
  });

  it("a preview goes stale if simulator data changes before commit", async () => {
    const buf = await editTemplate((wb) => setCell(wb, "patient_opt_out", "optedOut", "patientId", "SYN-PAT-1043", true));
    const p = await upload(buf, "edited.xlsx");
    await api(env, "POST", "/api/drafts/PA-DRAFT-99412/simulate-edit");
    expect((await api(env, "POST", `/api/data/import/${p.body.batchId}/commit`)).status).toBe(409);
  });

  it("a draft update without a version increase is rejected; with a higher version it is accepted", async () => {
    const same = await editTemplate((wb) => setCell(wb, "prior_auth_drafts", "updatedAt", "id", "PA-DRAFT-99413", "2026-10-18T15:00:00Z") );
    // updatedAt-only change is tolerated as unchanged content; change the policy version instead
    const changed = await editTemplate((wb) => setCell(wb, "prior_auth_drafts", "policyVersion", "id", "PA-DRAFT-99413", "SYN-SPINE-PA-2026-07"));
    const a = await upload(changed, "x.xlsx");
    expect(a.body.issues.some((i) => /without a version increase/.test(i.message))).toBe(true);
    const bumped = await editTemplate((wb) => {
      setCell(wb, "prior_auth_drafts", "policyVersion", "id", "PA-DRAFT-99413", "SYN-SPINE-PA-2026-07");
      setCell(wb, "prior_auth_drafts", "version", "id", "PA-DRAFT-99413", 3);
    });
    const b = await upload(bumped, "x.xlsx");
    expect(b.body.diff.prior_auth_drafts?.updated).toBe(1);
    expect(b.body.canCommit).toBe(true);
    // updatedAt is metadata: changing only it is accepted without a version bump
    expect((await upload(same, "same.xlsx")).body.issues).toEqual([]);
  });

  it("replace mode with a valid full workbook replaces the dataset and clears runtime tasks", async () => {
    const run = (await api<{ run: Run }>(env, "POST", "/api/drafts/PA-DRAFT-99412/check")).body.run;
    await api(env, "POST", `/api/runs/${run.runId}/stage`);
    expect(countRows(env.db, "ehr_tasks")).toBe(1);
    const buf = await editTemplate((wb) => setCell(wb, "patients", "ageBand", "id", "SYN-PAT-1049", "55-64"));
    const p = await upload(buf, "full.xlsx", "replace");
    expect(p.body.canCommit).toBe(true);
    await api(env, "POST", `/api/data/import/${p.body.batchId}/commit`);
    expect(countRows(env.db, "ehr_tasks")).toBe(0);
    expect((env.db.prepare("SELECT business_status FROM ehr_prior_auth_drafts WHERE id='PA-DRAFT-99412'").get() as { business_status: string }).business_status).toBe("DRAFT_INCOMPLETE");
  });

  it("viewers cannot import", async () => {
    expect((await upload(template(), "t.xlsx", "merge", "viewer")).status).toBe(403);
  });
});

describe("negative workbooks", () => {
  const expectIssue = (p: Preview, re: RegExp) => expect(p.issues.map((i) => `${i.sheet}:${i.row}:${i.column} ${i.message}`).join("\n")).toMatch(re);

  it("missing sheet blocks replace mode", async () => {
    const p = (await upload(readFileSync("data/templates/invalid/missing-sheet.xlsx"), "m.xlsx", "replace")).body;
    expectIssue(p, /coverage:null:null required sheet is missing/);
    expect(p.canCommit).toBe(false);
  });
  it("wrong types are reported with row and column", async () => {
    const p = (await upload(readFileSync("data/templates/invalid/wrong-types.xlsx"), "w.xlsx")).body;
    expectIssue(p, /prior_auth_drafts:2:version expected a whole number/);
    expectIssue(p, /provider_attribution:2:attributed expected TRUE or FALSE/);
    expect(p.diff.prior_auth_drafts?.rejected).toBe(1);
  });
  it("duplicate ids are rejected", async () => {
    const p = (await upload(readFileSync("data/templates/invalid/duplicate-ids.xlsx"), "d.xlsx")).body;
    expectIssue(p, /duplicate primary key SYN-PAT-1042/);
  });
  it("orphan references are rejected and cascade (replace mode)", async () => {
    const p = (await upload(readFileSync("data/templates/invalid/orphan-reference.xlsx"), "o.xlsx", "replace")).body;
    expectIssue(p, /coverage:2:patientId orphan reference: patient SYN-PAT-9999/);
    expectIssue(p, /service_requests:2:coverageId/);
    expectIssue(p, /prior_auth_drafts:2:serviceRequestId orphan reference: service request SR-99412/);
    expect(p.canCommit).toBe(false);
  });
  it("system-managed status values are rejected", async () => {
    const p = (await upload(readFileSync("data/templates/invalid/invalid-status.xlsx"), "s.xlsx")).body;
    expectIssue(p, /businessStatus is system-managed/);
  });
  it("formula cells are never evaluated and are rejected", async () => {
    const p = (await upload(readFileSync("data/templates/invalid/formula-cell.xlsx"), "f.xlsx")).body;
    expectIssue(p, /patients:2:ageBand formula cells are not accepted/);
    expect(countRows(env.db, "ehr_patients")).toBe(8);
  });
  it("stale revisions are rejected", async () => {
    const p = (await upload(readFileSync("data/templates/invalid/stale-revision.xlsx"), "st.xlsx")).body;
    expectIssue(p, /stale revision: incoming v1 is older than current v3/);
  });
  it("real-looking identifiers are rejected", async () => {
    const p = (await upload(readFileSync("data/templates/invalid/real-identifier.xlsx"), "r.xlsx")).body;
    expectIssue(p, /looks like an SSN/);
    expectIssue(p, /patient id must look like SYN-PAT/);
  });
  it("oversized and non-xlsx files are refused", async () => {
    const big = await upload(Buffer.alloc(2 * 1024 * 1024 + 10, 65), "big.xlsx");
    expect(big.status).toBe(413);
    const xlsm = await upload(Buffer.from("x"), "macro.xlsm");
    expectIssue(xlsm.body, /only .xlsx and .csv/);
    const junk = await upload(Buffer.from("not a zip"), "junk.xlsx");
    expectIssue(junk.body, /not a readable .xlsx/);
  });
  it("unknown identifier-like columns are flagged", async () => {
    const buf = await editTemplate((wb) => { wb.getWorksheet("patients")!.getRow(1).getCell(3).value = "fullName"; });
    const p = (await upload(buf, "c.xlsx")).body;
    expectIssue(p, /fullName unknown column \(possible direct identifier/);
  });
});

describe("CSV import and export safety", () => {
  it("imports one entity from <entity>.csv (merge)", async () => {
    const csv = readFileSync("data/templates/csv/patient_opt_out.csv", "utf8").replace("SYN-PAT-1043,false", "SYN-PAT-1043,true");
    const p = (await upload(Buffer.from(csv), "patient_opt_out.csv")).body;
    expect(p.diff.patient_opt_out).toMatchObject({ updated: 1, unchanged: 7 });
    expect(p.canCommit).toBe(true);
  });
  it("export neutralises formula-like strings (CSV and XLSX)", async () => {
    const csv = readFileSync("data/templates/csv/coverage.csv", "utf8").replace("Synthetic Medicare Advantage Plan (fictional),MEDICARE_ADVANTAGE,SYN-ORG-PAYER-900\r\nSYN-COV-2209", "@SUM(1+1) plan,MEDICARE_ADVANTAGE,SYN-ORG-PAYER-900\r\nSYN-COV-2209");
    const p = (await upload(Buffer.from(csv), "coverage.csv")).body;
    expect(p.canCommit).toBe(true);
    await api(env, "POST", `/api/data/import/${p.batchId}/commit`);
    const out = await (await fetch(`${env.baseUrl}/api/data/export/coverage.csv`)).text();
    expect(out).toContain("'@SUM(1+1) plan");
    const xbuf = Buffer.from(await (await fetch(`${env.baseUrl}/api/data/export.xlsx`)).arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xbuf as unknown as ArrayBuffer);
    let found = "";
    wb.getWorksheet("coverage")!.eachRow((r) => r.eachCell((c) => { if (String(c.value).includes("SUM(1+1)")) found = String(c.value); }));
    expect(found.startsWith("'@")).toBe(true);
    expect(wb.getWorksheet("tasks (read-only)")).toBeTruthy();
  });
});
