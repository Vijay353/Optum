/** Data Studio API: record browser, XLSX/CSV import (preview → commit), export, history, restore. */
import express, { Router, type RequestHandler } from "express";
import { join } from "node:path";
import { buildWorkbook, datasetToRows, toCsv } from "../data/workbook";
import { WORKBOOK_SHEETS, LIMITS } from "../data/workbookSchema";
import { loadFixtureDataset, readHieHashes } from "../data/datasetStore";
import { listTaskSummaries } from "../persistence/taskStore";
import { commitImport, ImportError, listBatches, previewImport, restoreBeforeImport } from "../data/importPipeline";
import { FIXTURES_DIR } from "./scenarios";
import { nowIso, type Db } from "../persistence/db";
import { readDataset } from "../data/datasetStore";
import { ENTITY_KEYS, type EntityKey } from "../data/dataset";
import { listEhrAudit } from "../persistence/auditStore";

type RoleGuard = (...roles: Array<"pa-specialist" | "viewer" | "sim-admin">) => RequestHandler;

export function createDataRouter(db: Db, opts: { requireRole: RoleGuard }): Router {
  const r = Router();
  const canWrite = opts.requireRole("pa-specialist", "sim-admin");
  const hieHashes = () => readHieHashes(db);
  const taskRows = () => listTaskSummaries(db);
  const sendFile = (res: express.Response, buf: Buffer | string, name: string, type: string) => {
    res.setHeader("content-type", type);
    res.setHeader("content-disposition", `attachment; filename="${name}"`);
    res.setHeader("x-content-type-options", "nosniff");
    res.send(buf);
  };

  r.get("/template.xlsx", async (_req, res) => {
    const { dataset } = loadFixtureDataset(join(FIXTURES_DIR, "base"));
    sendFile(res, await buildWorkbook(dataset, { title: "EvidenceBridge synthetic simulator workbook (template)" }), "evidencebridge-template.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  r.get("/export.xlsx", async (_req, res) => {
    const buf = await buildWorkbook(readDataset(db), { title: `EvidenceBridge simulator snapshot (synthetic) — exported ${nowIso(db)}`, tasks: taskRows(), hashes: hieHashes() });
    sendFile(res, buf, "evidencebridge-snapshot.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  r.get("/export/:entity.csv", (req, res) => {
    const spec = WORKBOOK_SHEETS.find((s) => s.sheet === req.params.entity);
    if (!spec) return void res.status(404).json({ error: "unknown entity" });
    sendFile(res, toCsv(datasetToRows(readDataset(db), spec.sheet, hieHashes()), spec.columns.map((c) => c.name)), `${spec.sheet}.csv`, "text/csv; charset=utf-8");
  });

  r.get("/schema", (_req, res) => res.json({ sheets: WORKBOOK_SHEETS, limits: LIMITS }));

  r.post("/import/preview", canWrite, express.raw({ type: "*/*", limit: LIMITS.maxBytes }), async (req, res) => {
    const filename = String(req.query.filename ?? "upload.xlsx");
    const mode = req.query.mode === "replace" ? "replace" : "merge";
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buffer.length) return void res.status(400).json({ error: "empty upload" });
    res.json(await previewImport(db, { buffer, filename, mode }));
  });

  r.post("/import/:batchId/commit", canWrite, (req, res) => {
    try {
      res.json(commitImport(db, String(req.params.batchId)));
    } catch (e) {
      if (e instanceof ImportError) return void res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  r.get("/imports", (_req, res) => res.json({ batches: listBatches(db) }));

  r.post("/imports/:batchId/restore", canWrite, (req, res) => {
    try {
      restoreBeforeImport(db, String(req.params.batchId));
      res.json({ restored: req.params.batchId });
    } catch (e) {
      if (e instanceof ImportError) return void res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  r.get("/records", (req, res) => {
    const entity: string = String(req.query.entity ?? "prior_auth_drafts");
    const q = String(req.query.q ?? "").toLowerCase();
    const ds = readDataset(db);
    let rows: Record<string, unknown>[];
    if (entity === "tasks") {
      rows = taskRows();
    } else if (entity === "ehr_audit") {
      rows = listEhrAudit(db, 200).map((a) => ({ seq: a.seq, at: a.at, actor: a.actor, action: a.action, resource: a.resource }));
    } else if ((ENTITY_KEYS as readonly string[]).includes(entity)) {
      rows = (ds[entity as EntityKey] as Record<string, unknown>[]).map((r) =>
        entity === "document_contents" ? { ...r, text: `${String(r.text).slice(0, 120)}…` } : r,
      );
    } else {
      return void res.status(400).json({ error: "unknown entity" });
    }
    const filtered = q ? rows.filter((row) => JSON.stringify(row).toLowerCase().includes(q)) : rows;
    res.json({ entity, total: rows.length, rows: filtered.slice(0, 500) });
  });

  return r;
}
