/**
 * XLSX / CSV parsing and generation (exceljs). Never evaluates formulas,
 * macros or external links: formula cells are rejected; only literal values
 * are read. Exports neutralise formula-like strings (CSV/Excel injection).
 */
import ExcelJS from "exceljs";
import { DATASET_SCHEMA_VERSION, ENTITY_KEYS, type Dataset, type EntityKey, type ValidationIssue } from "./dataset";
import { LIMITS, WORKBOOK_SHEETS, type ColumnSpec, type SheetSpec } from "./workbookSchema";

export type RawRows = Record<EntityKey, Array<{ rowNumber: number; data: Record<string, unknown> }>>;

export function emptyRaw(): RawRows {
  return Object.fromEntries(ENTITY_KEYS.map((k) => [k, []])) as unknown as RawRows;
}

// ---------------------------------------------------------------------------
// Cell → typed value
// ---------------------------------------------------------------------------
function convert(col: ColumnSpec, value: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  const blank = value === null || value === undefined || (typeof value === "string" && value.trim() === "");
  if (blank) {
    if (col.nullable) return { ok: true, value: null };
    if (!col.required) return { ok: true, value: undefined };
    return { ok: false, message: "required value is missing" };
  }
  if (typeof value === "string" && /^[=]/.test(value.trim())) return { ok: false, message: "value looks like a formula; formulas are not accepted" };
  switch (col.type) {
    case "string":
    case "text":
      return { ok: true, value: col.type === "text" ? String(value) : String(value).trim() };
    case "int": {
      const n = typeof value === "number" ? value : Number(String(value).trim());
      return Number.isInteger(n) ? { ok: true, value: n } : { ok: false, message: `expected a whole number, got "${String(value)}"` };
    }
    case "bool": {
      if (typeof value === "boolean") return { ok: true, value };
      const s = String(value).trim().toLowerCase();
      if (["true", "yes", "1"].includes(s)) return { ok: true, value: true };
      if (["false", "no", "0"].includes(s)) return { ok: true, value: false };
      return { ok: false, message: `expected TRUE or FALSE, got "${String(value)}"` };
    }
    case "date":
      if (value instanceof Date) return { ok: true, value: value.toISOString().slice(0, 10) };
      return { ok: true, value: String(value).trim() };
    case "datetime":
      if (value instanceof Date) return { ok: true, value: value.toISOString().replace(/\.000Z$/, "Z") };
      return { ok: true, value: String(value).trim() };
    case "list":
      return { ok: true, value: String(value).split(",").map((s) => s.trim()).filter(Boolean) };
  }
}

function rowsFromTable(spec: SheetSpec, header: string[], rows: Array<{ rowNumber: number; cells: unknown[] }>, issues: ValidationIssue[]) {
  const known = new Set(spec.columns.map((c) => c.name));
  for (const h of header) {
    if (!h) continue;
    if (!known.has(h)) {
      const hint = /name|dob|birth|address|ssn|phone|email|member/i.test(h) ? " (possible direct identifier — not allowed)" : "";
      issues.push({ sheet: spec.sheet, row: 1, column: h, message: `unknown column${hint}` });
    }
  }
  for (const col of spec.columns.filter((c) => c.required && c.editable)) {
    if (!header.includes(col.name)) issues.push({ sheet: spec.sheet, row: 1, column: col.name, message: "required column is missing" });
  }
  const out: Array<{ rowNumber: number; data: Record<string, unknown>; bad: boolean }> = [];
  for (const r of rows) {
    if (r.cells.every((v) => v === null || v === undefined || v === "")) continue;
    const data: Record<string, unknown> = {};
    let bad = false;
    header.forEach((h, i) => {
      const col = spec.columns.find((c) => c.name === h);
      if (!col || !col.editable) return; // system-managed columns are ignored on import
      const v = r.cells[i];
      if (v && typeof v === "object" && !(v instanceof Date) && "formula" in (v as object)) {
        issues.push({ sheet: spec.sheet, row: r.rowNumber, column: h, message: "formula cells are not accepted (values only)" });
        bad = true;
        return;
      }
      const conv = convert(col, v);
      if (!conv.ok) {
        issues.push({ sheet: spec.sheet, row: r.rowNumber, column: h, message: conv.message });
        bad = true;
      } else if (conv.value !== undefined) data[h] = conv.value;
    });
    out.push({ rowNumber: r.rowNumber, data, bad });
  }
  return out;
}

/** Re-nests flattened policy rows into PolicyVersion objects. */
function nestPolicies(rows: Array<{ rowNumber: number; data: Record<string, unknown>; bad: boolean }>, issues: ValidationIssue[]) {
  const by = new Map<string, { rowNumber: number; data: Record<string, unknown>; bad: boolean }>();
  for (const r of rows) {
    const d = r.data;
    const key = String(d.policyVersion ?? "");
    const req = {
      code: d.requirementCode, description: d.requirementDescription,
      localDocumentTypes: d.localDocumentTypes ?? [], externalDocumentTypes: d.externalDocumentTypes ?? [], lookbackMonths: d.lookbackMonths,
    };
    const existing = by.get(key);
    if (!existing) {
      by.set(key, {
        rowNumber: r.rowNumber, bad: r.bad,
        data: { policyVersion: d.policyVersion, status: d.status, serviceCategory: d.serviceCategory, label: d.label, effectiveFrom: d.effectiveFrom, effectiveTo: d.effectiveTo ?? null, requirements: [req] },
      });
    } else {
      for (const f of ["status", "serviceCategory", "label", "effectiveFrom"] as const) {
        if (existing.data[f] !== d[f]) issues.push({ sheet: "policy_requirements", row: r.rowNumber, column: f, message: `inconsistent ${f} for ${key} across rows` });
      }
      (existing.data.requirements as unknown[]).push(req);
      existing.bad = existing.bad || r.bad;
    }
  }
  return [...by.values()];
}

function finalize(raw: RawRows, entity: EntityKey, rows: Array<{ rowNumber: number; data: Record<string, unknown>; bad: boolean }>, issues: ValidationIssue[]) {
  const list = entity === "policy_requirements" ? nestPolicies(rows, issues) : rows;
  // Rows with conversion errors are still passed on, marked invalid, so they are counted as rejected.
  raw[entity] = list.map((r) => ({ rowNumber: r.rowNumber, data: r.bad ? { ...r.data, __invalid: true } : r.data }));
}

// ---------------------------------------------------------------------------
// XLSX import
// ---------------------------------------------------------------------------
export async function parseWorkbook(buf: Buffer): Promise<{ raw: RawRows; issues: ValidationIssue[]; schemaVersion: string | null; presentSheets: EntityKey[] }> {
  const issues: ValidationIssue[] = [];
  const raw = emptyRaw();
  if (buf.byteLength > LIMITS.maxBytes) {
    return { raw, issues: [{ sheet: "file", row: null, column: null, message: `file is ${(buf.byteLength / 1048576).toFixed(1)} MB; maximum is 2 MB` }], schemaVersion: null, presentSheets: [] };
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    return { raw, issues: [{ sheet: "file", row: null, column: null, message: "not a readable .xlsx workbook" }], schemaVersion: null, presentSheets: [] };
  }
  const meta = wb.getWorksheet("_meta");
  let schemaVersion: string | null = null;
  meta?.eachRow((row) => {
    if (String(row.getCell(1).value) === "schemaVersion") schemaVersion = String(row.getCell(2).value ?? "");
  });
  if (!schemaVersion) issues.push({ sheet: "_meta", row: null, column: null, message: "missing _meta sheet with schemaVersion" });
  else if ((schemaVersion as string).split(".")[0] !== DATASET_SCHEMA_VERSION.split(".")[0]) {
    issues.push({ sheet: "_meta", row: null, column: null, message: `unsupported schemaVersion ${schemaVersion}; expected ${DATASET_SCHEMA_VERSION}` });
  }

  const present: EntityKey[] = [];
  for (const spec of WORKBOOK_SHEETS) {
    const ws = wb.getWorksheet(spec.sheet);
    if (!ws) continue;
    present.push(spec.sheet);
    if (ws.actualColumnCount > LIMITS.maxColumns) {
      issues.push({ sheet: spec.sheet, row: null, column: null, message: `too many columns (${ws.actualColumnCount}; max ${LIMITS.maxColumns})` });
      continue;
    }
    if (ws.actualRowCount - 1 > LIMITS.maxRowsPerSheet) {
      issues.push({ sheet: spec.sheet, row: null, column: null, message: `too many rows (${ws.actualRowCount - 1}; max ${LIMITS.maxRowsPerSheet})` });
      continue;
    }
    const header: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { header[col - 1] = String(cell.value ?? "").trim(); });
    const rows: Array<{ rowNumber: number; cells: unknown[] }> = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return;
      const cells: unknown[] = [];
      for (let i = 1; i <= header.length; i++) {
        const cell = row.getCell(i);
        if (cell.type === ExcelJS.ValueType.Formula) cells.push({ formula: true });
        else if (cell.type === ExcelJS.ValueType.Hyperlink) cells.push((cell.value as { text?: string }).text ?? "");
        else if (cell.type === ExcelJS.ValueType.RichText) cells.push((cell.value as { richText: { text: string }[] }).richText.map((t) => t.text).join(""));
        else cells.push(cell.value);
      }
      rows.push({ rowNumber: n, cells });
    });
    finalize(raw, spec.sheet, rowsFromTable(spec, header, rows, issues), issues);
  }
  return { raw, issues, schemaVersion, presentSheets: present };
}

// ---------------------------------------------------------------------------
// CSV import (one entity per file, named <entity>.csv)
// ---------------------------------------------------------------------------
export function parseCsv(text: string, filename: string): { raw: RawRows; issues: ValidationIssue[]; presentSheets: EntityKey[] } {
  const issues: ValidationIssue[] = [];
  const raw = emptyRaw();
  const entity = filename.replace(/^.*[\\/]/, "").replace(/\.csv$/i, "") as EntityKey;
  const spec = WORKBOOK_SHEETS.find((s) => s.sheet === entity);
  if (!spec) {
    return { raw, issues: [{ sheet: "file", row: null, column: null, message: `CSV file name must be one of: ${WORKBOOK_SHEETS.map((s) => `${s.sheet}.csv`).join(", ")}` }], presentSheets: [] };
  }
  if (Buffer.byteLength(text) > LIMITS.maxBytes) return { raw, issues: [{ sheet: "file", row: null, column: null, message: "file exceeds 2 MB" }], presentSheets: [] };
  const table = parseCsvTable(text.replace(/^\uFEFF/, ""));
  if (table.length - 1 > LIMITS.maxRowsPerSheet) return { raw, issues: [{ sheet: entity, row: null, column: null, message: `too many rows (max ${LIMITS.maxRowsPerSheet})` }], presentSheets: [] };
  const header = (table[0] ?? []).map((h) => h.trim());
  if (header.length > LIMITS.maxColumns) return { raw, issues: [{ sheet: entity, row: null, column: null, message: `too many columns (max ${LIMITS.maxColumns})` }], presentSheets: [] };
  const rows = table.slice(1).map((cells, i) => ({ rowNumber: i + 2, cells }));
  finalize(raw, entity, rowsFromTable(spec, header, rows, issues), issues);
  return { raw, issues, presentSheets: [entity] };
}

function parseCsvTable(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      out.push(row); row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); out.push(row); }
  return out.filter((r) => r.some((c) => c !== ""));
}

// ---------------------------------------------------------------------------
// Export (XLSX + CSV) with formula-injection neutralisation
// ---------------------------------------------------------------------------
export function neutralize(v: unknown): unknown {
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(v)) return `'${v}`;
  return v;
}

export function datasetToRows(ds: Dataset, entity: EntityKey, hashes: Record<string, string> = {}): Record<string, unknown>[] {
  if (entity === "policy_requirements") {
    return ds.policy_requirements.flatMap((p) =>
      p.requirements.map((r) => ({
        policyVersion: p.policyVersion, status: p.status, serviceCategory: p.serviceCategory, label: p.label, effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo,
        requirementCode: r.code, requirementDescription: r.description, localDocumentTypes: r.localDocumentTypes.join(","),
        externalDocumentTypes: r.externalDocumentTypes.join(","), lookbackMonths: r.lookbackMonths,
      })),
    );
  }
  if (entity === "document_references") return ds.document_references.map((d) => ({ ...d, hashSha256: d.source === "HIE" ? hashes[d.id] ?? "" : "" }));
  return ds[entity] as unknown as Record<string, unknown>[];
}

export async function buildWorkbook(ds: Dataset, opts: { tasks?: Record<string, unknown>[]; title: string; hashes?: Record<string, string>; invalidExamples?: boolean }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "EvidenceBridge (synthetic)";
  wb.created = new Date("2026-10-18T00:00:00Z");
  const readme = wb.addWorksheet("README");
  readme.columns = [{ width: 28 }, { width: 26 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 46 }, { width: 70 }];
  const lines: unknown[][] = [
    [opts.title],
    ["SYNTHETIC DATA ONLY. Do not enter real patient, member, provider or payer data. Real-looking identifiers (SSNs, emails, phone numbers, non-SYN ids) are rejected."],
    [`Schema version ${DATASET_SCHEMA_VERSION}. Dates: YYYY-MM-DD. Date-times: ISO 8601 with explicit timezone (e.g. 2026-10-18T13:10:00Z).`],
    ["Excel is an interchange format, not a system of record. Imports are previewed, then committed atomically into the simulators after confirmation. Formulas, macros and links are never evaluated; formula cells are rejected."],
    ["Merge mode upserts by primary key (drafts require a higher version to change). Replace mode replaces the whole dataset and clears tasks/runs."],
    [],
    ["Sheet", "Column", "Type", "Required", "Editable", "Allowed values", "Description"],
  ];
  for (const s of WORKBOOK_SHEETS) {
    lines.push([`${s.sheet}  (PK: ${s.primaryKey}; owner: ${s.owner})`, "", "", "", "", "", s.description]);
    for (const col of s.columns) lines.push([s.sheet, col.name, col.type, col.required ? "yes" : "no", col.editable ? "yes" : "system", (col.allowed ?? []).join(", "), col.description]);
  }
  lines.forEach((l) => readme.addRow(l.map(neutralize)));
  readme.getRow(1).font = { bold: true, size: 14 };
  readme.getRow(7).font = { bold: true };

  const meta = wb.addWorksheet("_meta");
  meta.addRow(["schemaVersion", DATASET_SCHEMA_VERSION]);
  meta.addRow(["generatedAt", "2026-10-18T00:00:00Z"]);
  meta.addRow(["synthetic", "TRUE"]);

  for (const s of WORKBOOK_SHEETS) {
    const ws = wb.addWorksheet(s.sheet);
    ws.columns = s.columns.map((col) => ({ header: col.name, key: col.name, width: col.type === "text" ? 90 : Math.max(14, col.name.length + 4) }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF4ED" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    for (const r of datasetToRows(ds, s.sheet, opts.hashes)) {
      ws.addRow(s.columns.map((col) => {
        const v = r[col.name];
        return neutralize(Array.isArray(v) ? v.join(",") : v === null || v === undefined ? "" : v);
      }));
    }
  }
  if (opts.tasks) {
    const ws = wb.addWorksheet("tasks (read-only)");
    const keys = opts.tasks[0] ? Object.keys(opts.tasks[0]) : ["id", "draftId", "status", "businessStatus", "owner", "focus", "createdAt"];
    ws.columns = keys.map((k) => ({ header: k, key: k, width: 26 }));
    ws.getRow(1).font = { bold: true };
    for (const t of opts.tasks) ws.addRow(keys.map((k) => neutralize(t[k])));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const esc = (v: unknown) => {
    const s = String(neutralize(Array.isArray(v) ? v.join(",") : v ?? ""));
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\r\n") + "\r\n";
}
