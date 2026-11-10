/**
 * Mock Provider EHR / FHIR server (behavioral simulator, not a vendor clone).
 * Owns: patients (age band only), coverage, service requests, local document
 * metadata, prior-auth drafts, FHIR-like Tasks, idempotency, audit, outbox.
 */
import { Router, type Request, type Response } from "express";
import { tx, nowIso, type Db } from "../persistence/db";
import { appendEhrAudit, listEhrAudit } from "../persistence/auditStore";
import { findIdempotency, saveIdempotency } from "../persistence/idempotencyStore";
import { getTask, insertTask, listTasksForDraft, nextTaskId } from "../persistence/taskStore";
import { canonicalJson, sha256Hex } from "../domain/integrity";
import { canTransition } from "../domain/stateMachine";
import {
  CreateEvidenceReviewTaskInputSchema,
  DraftBusinessStatus,
  type CreateEvidenceReviewTaskResult,
  type FhirTask,
  type PriorAuthDraftCreated,
} from "../domain/contracts";
import { applyTransportFault, clientOf, operationOutcome, requireScope, takeFault } from "./shared";

type DraftRow = {
  id: string; version: number; service_request_id: string; patient_id: string; coverage_id: string;
  policy_version: string; business_status: string; created_at: string; updated_at: string;
};

export function draftResource(r: DraftRow) {
  return {
    resourceType: "PriorAuthorizationDraft",
    id: r.id,
    version: r.version,
    serviceRequestId: r.service_request_id,
    patientId: r.patient_id,
    coverageId: r.coverage_id,
    policyVersion: r.policy_version,
    businessStatus: r.business_status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    meta: { versionId: String(r.version), lastUpdated: r.updated_at },
  };
}

function getDraftRow(db: Db, id: string): DraftRow | undefined {
  return db.prepare("SELECT * FROM ehr_prior_auth_drafts WHERE id = ?").get(id) as DraftRow | undefined;
}

/** Fingerprint of clinical chart content used to prove no chart mutation occurred. */
function chartFingerprint(db: Db, patientId: string): string {
  const docs = db.prepare("SELECT id, type, title, date FROM ehr_documents WHERE patient_id = ? ORDER BY id").all(patientId);
  const srs = db.prepare("SELECT * FROM ehr_service_requests WHERE patient_id = ? ORDER BY id").all(patientId);
  const cov = db.prepare("SELECT * FROM ehr_coverage WHERE patient_id = ? ORDER BY id").all(patientId);
  return sha256Hex(canonicalJson({ docs, srs, cov }));
}

export function createEhrRouter(db: Db): Router {
  const r = Router();

  r.use(async (req, res, next) => {
    // Transport faults for reads (task reads have their own fault point).
    if (req.method === "GET" && !req.path.startsWith("/fhir/Task") && !req.path.startsWith("/_admin")) {
      if (await applyTransportFault(db, "ehr.read", res)) return;
    }
    next();
  });

  r.get("/fhir/Patient/:id", requireScope("Patient.read"), (req, res) => {
    const row = db.prepare("SELECT id, age_band FROM ehr_patients WHERE id = ?").get(String(req.params.id)) as { id: string; age_band: string } | undefined;
    if (!row) return void res.status(404).json(operationOutcome("not-found", "Patient not found"));
    res.json({
      resourceType: "Patient",
      id: row.id,
      identifier: [{ system: "urn:synthetic:patient", value: row.id }],
      extension: [{ url: "urn:synthetic:age-band", valueString: row.age_band }],
      meta: { tag: [{ code: "SYNTHETIC" }] },
    });
  });

  r.get("/fhir/ServiceRequest/:id", requireScope("ServiceRequest.read"), (req, res) => {
    const s = db.prepare("SELECT * FROM ehr_service_requests WHERE id = ?").get(String(req.params.id)) as Record<string, string> | undefined;
    if (!s) return void res.status(404).json(operationOutcome("not-found", "ServiceRequest not found"));
    res.json({
      resourceType: "ServiceRequest",
      id: s.id,
      status: "active",
      intent: "order",
      subject: { reference: `Patient/${s.patient_id}` },
      insurance: [{ reference: `Coverage/${s.coverage_id}` }],
      code: { text: s.description },
      category: [{ text: s.service_category }],
      authoredOn: s.requested_date,
      requester: { reference: `Organization/${s.ordering_org_id}` },
    });
  });

  r.get("/fhir/Coverage/:id", requireScope("Coverage.read"), (req, res) => {
    const c = db.prepare("SELECT * FROM ehr_coverage WHERE id = ?").get(String(req.params.id)) as Record<string, string> | undefined;
    if (!c) return void res.status(404).json(operationOutcome("not-found", "Coverage not found"));
    res.json({
      resourceType: "Coverage",
      id: c.id,
      status: "active",
      beneficiary: { reference: `Patient/${c.patient_id}` },
      payor: [{ reference: `Organization/${c.payer_org_id}` }],
      class: [{ type: { text: "plan" }, value: c.plan_type, name: c.plan_name }],
    });
  });

  r.get("/fhir/DocumentReference", requireScope("DocumentReference.read"), (req, res) => {
    const patient = String(req.query.patient ?? "");
    if (!patient) return void res.status(400).json(operationOutcome("required", "patient search parameter is required"));
    const rows = db.prepare("SELECT * FROM ehr_documents WHERE patient_id = ? ORDER BY date DESC").all(patient) as Record<string, string>[];
    res.json({
      resourceType: "Bundle",
      type: "searchset",
      total: rows.length,
      entry: rows.map((d) => ({
        resource: { resourceType: "DocumentReference", id: d.id, status: "current", subject: { reference: `Patient/${d.patient_id}` }, type: { text: d.type }, description: d.title, date: d.date },
      })),
    });
  });

  r.get("/prior-auth-drafts/:id", requireScope("Draft.read"), (req, res) => {
    const d = getDraftRow(db, String(req.params.id));
    if (!d) return void res.status(404).json(operationOutcome("not-found", "Draft not found"));
    res.setHeader("ETag", `W/"${d.version}"`);
    res.json(draftResource(d));
  });

  /** The EHR's workflow engine emits PriorAuthDraftCreated from current draft state (outbox). */
  r.post("/prior-auth-drafts/:id/emit-created", requireScope("Draft.emit"), (req, res) => {
    const d = getDraftRow(db, String(req.params.id));
    if (!d) return void res.status(404).json(operationOutcome("not-found", "Draft not found"));
    const eventId = `evt-pa-${d.id.replace(/^PA-DRAFT-/, "")}-v${d.version}`;
    const existing = db.prepare("SELECT payload_json, delivery_count FROM ehr_outbox WHERE event_id = ?").get(eventId) as
      | { payload_json: string; delivery_count: number }
      | undefined;
    if (existing) {
      db.prepare("UPDATE ehr_outbox SET delivery_count = delivery_count + 1 WHERE event_id = ?").run(eventId);
      return void res.json({ event: JSON.parse(existing.payload_json), deliveryCount: existing.delivery_count + 1 });
    }
    const event: PriorAuthDraftCreated = {
      eventId,
      draftId: d.id,
      draftVersion: d.version,
      serviceRequestId: d.service_request_id,
      patientId: d.patient_id,
      coverageId: d.coverage_id,
      occurredAt: nowIso(db),
    };
    db.prepare("INSERT INTO ehr_outbox (event_id, draft_id, payload_json, emitted_at) VALUES (?,?,?,?)").run(eventId, d.id, JSON.stringify(event), event.occurredAt);
    appendEhrAudit(db, clientOf(req)?.clientId ?? "?", "EVENT_EMITTED", `Draft/${d.id}`, { eventId, draftVersion: d.version });
    res.status(201).json({ event, deliveryCount: 1 });
  });

  /** Demo: another user edits the draft content, bumping its version (optimistic-concurrency demo). */
  r.patch("/prior-auth-drafts/:id", requireScope("Draft.write"), (req, res) => {
    const d = getDraftRow(db, String(req.params.id));
    if (!d) return void res.status(404).json(operationOutcome("not-found", "Draft not found"));
    const expected = Number(req.body?.expectedVersion);
    if (!Number.isInteger(expected) || expected !== d.version) {
      return void res.status(409).json(operationOutcome("conflict", "version conflict", { currentVersion: d.version }));
    }
    const at = nowIso(db);
    db.prepare("UPDATE ehr_prior_auth_drafts SET version = version + 1, updated_at = ? WHERE id = ?").run(at, d.id);
    appendEhrAudit(db, clientOf(req)?.clientId ?? "?", "DRAFT_EDITED", `Draft/${d.id}`, { fromVersion: d.version, toVersion: d.version + 1, note: String(req.body?.note ?? "") });
    res.json(draftResource(getDraftRow(db, d.id)!));
  });

  // -------------------------------------------------------------------------
  // createEvidenceReviewTask — the only mutating capability exposed to the orchestrator.
  // -------------------------------------------------------------------------
  r.post("/fhir/Task", requireScope("Task.write"), async (req: Request, res: Response) => {
    if (await applyTransportFault(db, "ehr.task.create", res)) return;
    const actor = clientOf(req)!.clientId;
    const parsed = CreateEvidenceReviewTaskInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return void res.status(422).json(operationOutcome("invalid", "schema validation failed", { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }));
    }
    const input = parsed.data;
    const headerKey = req.header("idempotency-key");
    if (headerKey && headerKey !== input.idempotencyKey) {
      return void res.status(422).json(operationOutcome("invalid", "Idempotency-Key header does not match body"));
    }
    const requestHash = sha256Hex(canonicalJson(input));

    // 1) Durable idempotency — checked before version so a replay returns the original result.
    const prior = findIdempotency(db, input.idempotencyKey);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        return void res.status(422).json(operationOutcome("conflict", "idempotency key reused with a different payload"));
      }
      const replay = { ...(JSON.parse(prior.responseJson) as CreateEvidenceReviewTaskResult), duplicate: true };
      appendEhrAudit(db, actor, "TASK_CREATE_REPLAYED", `Task/${replay.taskId}`, { idempotencyKey: input.idempotencyKey });
      return void res.status(200).json(replay);
    }

    // Behavior fault: a concurrent clinician edit lands just before this write.
    if (takeFault(db, "ehr.task.concurrentEdit")) {
      const d = getDraftRow(db, input.draftId);
      if (d) {
        db.prepare("UPDATE ehr_prior_auth_drafts SET version = version + 1, updated_at = ? WHERE id = ?").run(nowIso(db), d.id);
        appendEhrAudit(db, "demo-clinician-ui (simulated concurrent edit)", "DRAFT_EDITED", `Draft/${d.id}`, { fromVersion: d.version, toVersion: d.version + 1 });
      }
    }

    let result: CreateEvidenceReviewTaskResult;
    try {
      result = tx(db, () => {
        const d = getDraftRow(db, input.draftId);
        if (!d) throw new HttpError(404, operationOutcome("not-found", "Draft not found"));
        if (d.version !== input.expectedDraftVersion) {
          throw new HttpError(409, operationOutcome("conflict", "draft version conflict", { code: "VERSION_CONFLICT", currentVersion: d.version }));
        }
        if (d.patient_id !== input.syntheticPatientId || d.service_request_id !== input.serviceRequestId) {
          throw new HttpError(422, operationOutcome("invalid", "draft does not match patient/service request in the request"));
        }
        if (d.policy_version !== input.policyVersion) {
          throw new HttpError(409, operationOutcome("conflict", "policy version on draft differs", { code: "POLICY_CONFLICT" }));
        }
        const from = DraftBusinessStatus.safeParse(d.business_status);
        // An unknown stored status is never treated as a valid starting state (V3 CH-2).
        if (!from.success || !canTransition(from.data, "EVIDENCE_REVIEW_PENDING")) {
          throw new HttpError(409, operationOutcome("business-rule", `invalid transition ${d.business_status} → EVIDENCE_REVIEW_PENDING`, { code: "INVALID_TRANSITION" }));
        }
        const chartBefore = chartFingerprint(db, d.patient_id);
        const at = nowIso(db);
        const task: FhirTask = {
          resourceType: "Task",
          id: nextTaskId(db, d.patient_id),
          status: "requested",
          businessStatus: { text: "EVIDENCE_REVIEW_PENDING" },
          intent: "order",
          code: { text: "Review external evidence before prior-authorization submission" },
          focus: { reference: `ServiceRequest/${d.service_request_id}` },
          for: { reference: `Patient/${d.patient_id}` },
          owner: { reference: `CareTeam/${input.reviewerQueue}` },
          authoredOn: at,
          restriction: { period: { end: input.dueAt } },
          input: [
            { type: { text: "draft" }, valueString: `${d.id}|v${d.version}` },
            { type: { text: "missingRequirement" }, valueString: input.missingRequirementCode },
            { type: { text: "policyVersion" }, valueString: input.policyVersion },
            { type: { text: "evidenceDocument" }, valueString: `DocumentReference/${input.evidenceDocumentId}` },
            { type: { text: "evidenceDocumentHash" }, valueString: input.evidenceDocumentHash },
            { type: { text: "extractionHash" }, valueString: input.extractionHash },
            { type: { text: "claimLeads" }, valueString: input.claimLeadIds.map((c) => `ExplanationOfBenefit/${c}`).join(",") },
            { type: { text: "reviewNote" }, valueString: "Claims are leads, not proof. Review source and patient match; decide whether evidence belongs in the packet." },
          ],
          meta: { versionId: "1", lastUpdated: at },
        };
        insertTask(db, task, d.id, input.idempotencyKey);
        db.prepare("UPDATE ehr_prior_auth_drafts SET business_status = 'EVIDENCE_REVIEW_PENDING', updated_at = ? WHERE id = ?").run(at, d.id);
        const chartAfter = chartFingerprint(db, d.patient_id);
        const chartMutationPerformed = chartBefore !== chartAfter;
        if (chartMutationPerformed) throw new Error("invariant violated: chart content changed during task creation");
        const out: CreateEvidenceReviewTaskResult = {
          taskId: task.id,
          status: "requested",
          businessStatus: "EVIDENCE_REVIEW_PENDING",
          duplicate: false,
          draftVersion: d.version,
          chartMutationPerformed: false,
          payerSubmissionPerformed: false,
        };
        saveIdempotency(db, { key: input.idempotencyKey, requestHash, responseJson: JSON.stringify(out), createdAt: at });
        appendEhrAudit(db, actor, "TASK_CREATED", `Task/${task.id}`, {
          draftId: d.id, draftVersion: d.version, idempotencyKey: input.idempotencyKey, evidenceDocumentHash: input.evidenceDocumentHash,
          chartFingerprintUnchanged: true,
        });
        appendEhrAudit(db, actor, "DRAFT_STATUS_CHANGED", `Draft/${d.id}`, { from: d.business_status, to: "EVIDENCE_REVIEW_PENDING" });
        return out;
      });
    } catch (err) {
      if (err instanceof HttpError) {
        appendEhrAudit(db, actor, "TASK_CREATE_REJECTED", `Draft/${input.draftId}`, { status: err.status, idempotencyKey: input.idempotencyKey });
        return void res.status(err.status).json(err.body);
      }
      throw err;
    }

    // Behavior fault: commit succeeded but the response is lost (partial failure).
    if (takeFault(db, "ehr.task.dropResponseAfterCommit")) {
      return void res.status(503).json(operationOutcome("transient", "simulated response loss after commit"));
    }
    res.setHeader("Location", `Task/${result.taskId}`);
    res.status(201).json(result);
  });

  r.get("/fhir/Task/:id", requireScope("Task.read"), async (req, res) => {
    if (await applyTransportFault(db, "ehr.task.read", res)) return;
    const task = getTask(db, String(req.params.id));
    if (!task) return void res.status(404).json(operationOutcome("not-found", "Task not found"));
    if (takeFault(db, "ehr.task.readbackMismatch")) {
      return void res.json({ ...task, owner: { reference: "CareTeam/some-other-queue" } });
    }
    res.json(task);
  });

  r.get("/fhir/Task", requireScope("Task.read"), (req, res) => {
    const draft = String(req.query.draft ?? "");
    if (!draft) return void res.status(400).json(operationOutcome("required", "draft parameter required"));
    const tasks = listTasksForDraft(db, draft);
    res.json({ resourceType: "Bundle", type: "searchset", total: tasks.length, entry: tasks.map((t) => ({ resource: t })) });
  });

  r.get("/_admin/audit", requireScope("Admin.read"), (_req, res) => {
    res.json(listEhrAudit(db));
  });

  return r;
}

class HttpError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(`HTTP ${status}`);
  }
}
