/**
 * Mock HIE document server (behavioral simulator). Read-only.
 * Search requires a patient parameter (record locator / MPI index); every
 * DocumentReference carries the HIE's MPI match confidence and a SHA-256 of
 * the Binary payload.
 */
import { Router } from "express";
import type { Db } from "../persistence/db";
import { applyTransportFault, logAccess, operationOutcome, requireScope, takeFault } from "./shared";

type DocRow = {
  id: string; indexed_patient_id: string; match_confidence: string; author_org_id: string; author_name: string; type: string;
  title: string; date: string; period_start: string; period_end: string; content_type: string; hash_sha256: string;
};

function toResource(d: DocRow) {
  return {
    resourceType: "DocumentReference",
    id: d.id,
    status: "current",
    type: { text: d.type },
    subject: { reference: `Patient/${d.indexed_patient_id}` },
    author: [{ reference: `Organization/${d.author_org_id}`, display: d.author_name }],
    description: d.title,
    date: d.date,
    context: { period: { start: d.period_start, end: d.period_end } },
    content: [{ attachment: { contentType: d.content_type, url: `Binary/BIN-${d.id}`, title: d.title } }],
    extension: [
      { url: "urn:synthetic:hie:mpi-match-confidence", valueCode: d.match_confidence },
      // FHIR attachment.hash is base64 SHA-1; this simulator publishes SHA-256 hex in an extension instead.
      { url: "urn:synthetic:hie:payload-sha256", valueString: d.hash_sha256 },
    ],
    meta: { tag: [{ code: "SYNTHETIC" }] },
  };
}

export function createHieRouter(db: Db): Router {
  const r = Router();
  r.use(logAccess(db, "hie_access_log"));

  r.get("/fhir/DocumentReference", requireScope("HIE.read"), async (req, res) => {
    if (await applyTransportFault(db, "hie.search", res)) return;
    const patient = String(req.query.patient ?? "");
    if (!patient) return void res.status(400).json(operationOutcome("required", "patient parameter is required (minimum necessary)"));
    const clauses = ["indexed_patient_id = ?"];
    const args: string[] = [patient];
    if (req.query.author) { clauses.push("author_org_id = ?"); args.push(String(req.query.author)); }
    if (req.query.type) { clauses.push("type = ?"); args.push(String(req.query.type)); }
    if (req.query["period-start-ge"]) { clauses.push("period_end >= ?"); args.push(String(req.query["period-start-ge"])); }
    if (req.query["period-end-le"]) { clauses.push("period_start <= ?"); args.push(String(req.query["period-end-le"])); }
    const rows = db.prepare(`SELECT * FROM hie_documents WHERE ${clauses.join(" AND ")} ORDER BY date DESC`).all(...args) as DocRow[];
    res.json({ resourceType: "Bundle", type: "searchset", total: rows.length, entry: rows.map((d) => ({ resource: toResource(d) })) });
  });

  r.get("/fhir/DocumentReference/:id", requireScope("HIE.read"), (req, res) => {
    const d = db.prepare("SELECT * FROM hie_documents WHERE id = ?").get(String(req.params.id)) as DocRow | undefined;
    if (!d) return void res.status(404).json(operationOutcome("not-found", "DocumentReference not found"));
    res.json(toResource(d));
  });

  r.get("/Binary/:id", requireScope("HIE.read"), async (req, res) => {
    if (await applyTransportFault(db, "hie.binary", res)) return;
    const b = db.prepare("SELECT content FROM hie_binaries WHERE id = ?").get(String(req.params.id)) as { content: string } | undefined;
    if (!b) return void res.status(404).json(operationOutcome("not-found", "Binary not found"));
    let content = b.content;
    if (takeFault(db, "hie.binary.corrupt")) content = content + "\n[payload altered in transit — simulated]";
    res.type("text/plain; charset=utf-8").send(content);
  });

  r.all("/{*rest}", (_req, res) => {
    res.status(405).json(operationOutcome("not-supported", "Mock HIE is read-only"));
  });
  return r;
}
