/**
 * Mock CMS-0057-F-style Provider Access server (behavioral simulator).
 * A FUTURE production dependency: Provider Access APIs are generally required
 * from January 1, 2027. This simulator is read-only and has NO submission
 * capability. It enforces attribution + opt-out itself (defence in depth).
 */
import { Router } from "express";
import { nowIso, type Db } from "../persistence/db";
import { applyTransportFault, logAccess, operationOutcome, requireScope } from "./shared";

export type AccessDecision = {
  patientId: string;
  providerOrgId: string;
  attributed: boolean;
  treatmentRelationship: string;
  optedOut: boolean;
  decision: "PERMIT" | "DENY";
  reasons: string[];
  asOf: string;
};

export function evaluateAccess(db: Db, patientId: string, providerOrgId: string, asOfDate: string): AccessDecision {
  const attr = db.prepare("SELECT * FROM payer_attribution WHERE patient_id = ? AND provider_org_id = ?").get(patientId, providerOrgId) as
    | { attributed: number; treatment_relationship: string; effective_from: string; effective_to: string | null }
    | undefined;
  const opt = db.prepare("SELECT opted_out FROM payer_opt_out WHERE patient_id = ?").get(patientId) as { opted_out: number } | undefined;
  const reasons: string[] = [];
  const inWindow = !!attr && attr.effective_from <= asOfDate && (!attr.effective_to || attr.effective_to >= asOfDate);
  const attributed = !!attr && attr.attributed === 1 && attr.treatment_relationship === "ESTABLISHED" && inWindow;
  const optedOut = opt?.opted_out === 1;
  if (!attr) reasons.push("No attribution record for this provider.");
  else {
    if (attr.attributed !== 1) reasons.push("Payer attribution process did not attribute this patient to the provider.");
    if (attr.treatment_relationship !== "ESTABLISHED") reasons.push("No established treatment relationship.");
    if (!inWindow) reasons.push("Attribution is not effective on the request date.");
  }
  if (optedOut) reasons.push("Patient opted out of Provider Access data sharing.");
  return {
    patientId,
    providerOrgId,
    attributed,
    treatmentRelationship: attr?.treatment_relationship ?? "NONE",
    optedOut,
    decision: attributed && !optedOut ? "PERMIT" : "DENY",
    reasons,
    asOf: asOfDate,
  };
}

export function createPayerRouter(db: Db): Router {
  const r = Router();
  r.use(logAccess(db, "payer_access_log"));

  r.get("/access/:patientId/authorization", requireScope("ProviderAccess.read"), async (req, res) => {
    if (await applyTransportFault(db, "payer.authorization", res)) return;
    const provider = String(req.query.provider ?? "");
    const asOf = String(req.query.asOf ?? nowIso(db).slice(0, 10));
    if (!provider) return void res.status(400).json(operationOutcome("required", "provider parameter required"));
    res.json(evaluateAccess(db, String(req.params.patientId), provider, asOf));
  });

  r.get("/fhir/ExplanationOfBenefit", requireScope("Claims.read"), async (req, res) => {
    if (await applyTransportFault(db, "payer.eob", res)) return;
    const patient = String(req.query.patient ?? "");
    const provider = req.header("x-requesting-provider") ?? "";
    const asOf = String(req.query.asOf ?? nowIso(db).slice(0, 10));
    if (!patient || !provider) return void res.status(400).json(operationOutcome("required", "patient parameter and X-Requesting-Provider header required"));
    const access = evaluateAccess(db, patient, provider, asOf);
    if (access.decision !== "PERMIT") {
      return void res.status(403).json(operationOutcome("forbidden", "Provider Access not permitted", { reasons: access.reasons }));
    }
    const rows = db.prepare("SELECT * FROM payer_eob WHERE patient_id = ? ORDER BY service_date").all(patient) as Record<string, string>[];
    res.json({
      resourceType: "Bundle",
      type: "searchset",
      total: rows.length,
      entry: rows.map((e) => ({
        resource: {
          resourceType: "ExplanationOfBenefit",
          id: e.id,
          status: "active",
          use: "claim",
          outcome: e.outcome,
          patient: { reference: `Patient/${e.patient_id}` },
          provider: { reference: `Organization/${e.provider_org_id}`, display: e.provider_name },
          created: e.adjudicated_at,
          item: [{ sequence: 1, servicedDate: e.service_date, productOrService: { coding: [{ code: e.code, display: e.code_display }] } }],
          meta: { tag: [{ code: "SYNTHETIC" }, { code: "CLAIMS-ARE-NOT-CLINICAL-PROOF" }] },
        },
      })),
    });
  });

  /** V3 CH-1: count of non-GET requests this server received since a time. SIMULATED only. */
  r.get("/_admin/write-count", requireScope("SimProbe.read"), async (req, res) => {
    if (await applyTransportFault(db, "payer.probe", res)) return;
    const since = String(req.query.since ?? "");
    if (!since || Number.isNaN(Date.parse(since))) return void res.status(400).json(operationOutcome("required", "since must be an ISO 8601 time"));
    const n = (db.prepare("SELECT COUNT(*) AS n FROM payer_access_log WHERE method <> 'GET' AND at >= ?").get(since) as { n: number }).n;
    res.json({ since, writeRequests: n });
  });

  r.get("/_admin/access-log", requireScope("Admin.read"), (_req, res) => {
    res.json(db.prepare("SELECT * FROM payer_access_log ORDER BY seq DESC LIMIT 200").all());
  });

  // No write endpoints exist. Any other method is refused and logged.
  r.all("/{*rest}", (_req, res) => {
    res.status(405).json(operationOutcome("not-supported", "Mock Provider Access server is read-only; no submission endpoints exist"));
  });
  return r;
}
