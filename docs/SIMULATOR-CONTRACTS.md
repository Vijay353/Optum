# Simulator contracts

Behavioral simulators — interoperable approximations, **not** vendor clones or certified implementations. All data is synthetic. Every endpoint requires `Authorization: Bearer <demo token>` with the listed scope.

| Token | Client | Scopes |
|---|---|---|
| `eb-orchestrator-local` | EvidenceBridge orchestrator | Patient/ServiceRequest/Coverage/DocumentReference/Draft read, Task read+write, ProviderAccess/Claims/HIE/Policy read, SimProbe.read (SIMULATED only) |
| `eb-ehr-workflow-local` | EHR workflow engine | Draft read, Draft emit |
| `eb-demo-clinician-local` | Demo clinician | Draft read, Draft write |
| `eb-sim-admin-local` | Simulator admin | Admin read, Draft read, Task read |

## Mock Provider EHR / FHIR (`/mock-ehr`)

| Method & path | Scope | Behaviour |
|---|---|---|
| `GET /fhir/Patient/:id` | Patient.read | Identifier + age band extension only |
| `GET /fhir/ServiceRequest/:id` | ServiceRequest.read | FHIR-like ServiceRequest |
| `GET /fhir/Coverage/:id` | Coverage.read | FHIR-like Coverage |
| `GET /fhir/DocumentReference?patient=` | DocumentReference.read | Local chart document metadata (search requires `patient`) |
| `GET /prior-auth-drafts/:id` | Draft.read | Draft with `version`, `businessStatus`; `ETag: W/"<version>"` |
| `POST /prior-auth-drafts/:id/emit-created` | Draft.emit | Emits `PriorAuthDraftCreated` from current state; event id `evt-pa-<n>-v<version>`; re-emits increment `deliveryCount` |
| `PATCH /prior-auth-drafts/:id` | Draft.write | Demo content edit; requires `expectedVersion`; bumps version; 409 on mismatch |
| `POST /fhir/Task` | Task.write | **createEvidenceReviewTask** (below) |
| `GET /fhir/Task/:id`, `GET /fhir/Task?draft=` | Task.read | Read-back |
| `GET /_admin/audit` | Admin.read | Append-only audit |

**`POST /fhir/Task`** — body = `CreateEvidenceReviewTaskInput` (strict Zod). Order of checks: scope → schema (422) → `Idempotency-Key` header equals body key (422) → durable idempotency (same key + same payload → 200 stored result with `duplicate: true`; same key + different payload → 422) → in one transaction: draft exists (404), `version == expectedDraftVersion` (409 `VERSION_CONFLICT` with `currentVersion`), patient/service request match (422), policy version match (409 `POLICY_CONFLICT`), transition allowed (409 `INVALID_TRANSITION`), insert Task, set draft `EVIDENCE_REVIEW_PENDING`, chart fingerprint unchanged, save idempotency, audit. 201 returns `CreateEvidenceReviewTaskResult` with literal `chartMutationPerformed: false`, `payerSubmissionPerformed: false`.

Task id: `TASK-EVID-<patient number>` (deterministic, suffixed if reused). Owner `CareTeam/pa-specialist-queue`. Draft `version` is a content revision and does not change on the status transition.

## Mock Provider Access (`/mock-payer`) — future CMS-0057-F dependency

| Method & path | Scope | Behaviour |
|---|---|---|
| `GET /access/:patientId/authorization?provider=&asOf=` | ProviderAccess.read | `PERMIT` only if attributed, relationship `ESTABLISHED`, attribution effective on `asOf`, and not opted out; reasons listed |
| `GET /fhir/ExplanationOfBenefit?patient=&asOf=` + `X-Requesting-Provider` | Claims.read | Re-evaluates access (403 if denied — defence in depth); Bundle of EOBs tagged `CLAIMS-ARE-NOT-CLINICAL-PROOF` |
| `GET /_admin/write-count?since=` | SimProbe.read | V3 CH-1. `{ since, writeRequests }`: non-GET requests received since that time. Used by the read-back through `SimulatorProbePort`. Fault point `payer.probe`. Real payers have no such route; SANDBOX/LIVE leave the probe out and the check is not evaluated. |
| any other method/path | — | 405 — read-only, **no submission endpoint exists** |

Every request is logged in `payer_access_log`; the orchestrator's readback verifies zero non-GET requests during execution.

## Mock HIE (`/mock-hie`)

| Method & path | Scope | Behaviour |
|---|---|---|
| `GET /fhir/DocumentReference?patient=&author=&type=&period-start-ge=&period-end-le=` | HIE.read | `patient` required (minimum necessary); results carry MPI match confidence (`exact`/`probable`) and payload SHA-256 extensions |
| `GET /fhir/DocumentReference/:id` | HIE.read | Single document |
| `GET /Binary/:id` | HIE.read | `text/plain`, pages separated by form feed |

## Synthetic policy (`/mock-policy`)

`GET /policies/:policyVersion` → versioned checklist (`active`/`retired`), requirements with local/external document types and lookback months. Label always begins with `SYNTHETIC`.

## Scenario clock (`/api/clock`)

| Method & path | Role | Behaviour |
|---|---|---|
| `GET /api/clock` | any | `{ mode: "scenario" | "system", now, anchor, offsetMs }` |
| `POST /api/clock/advance` `{ hours }` | pa-specialist, sim-admin | Moves scenario time forward (1 to 720 hours). 409 when a test clock is injected. Reloading a scenario resets it. |

## Fault injection (`/api/faults`, scenario fixtures)

| Key | Kind | Effect |
|---|---|---|
| `payer.authorization`, `payer.eob`, `hie.search`, `hie.binary`, `ehr.read`, `ehr.task.create`, `ehr.task.read` | `timeout` / `status` (429, 401, 403, 404, 409, 5xx) / `latency` | Transport faults; `remaining: n` fires n times, `null` always |
| `hie.binary.corrupt` | behavior | Payload altered → hash mismatch |
| `ehr.task.concurrentEdit` | behavior | Draft version bumped just before the Task write → 409 |
| `ehr.task.dropResponseAfterCommit` | behavior | Commit succeeds, response is 503 → idempotent retry |
| `ehr.task.readbackMismatch` | behavior | Readback returns a different owner → run FAILED |

Client behaviour: 1.5 s timeout (250 ms in tests), up to 2 retries with exponential backoff + full jitter on timeout/network/429/500/502/503/504; `Retry-After` honoured (capped). Writes retry only because the EHR enforces idempotency.

## Response validation (V3 CH-2)

Every simulator response is checked against a schema in `src/adapters/wireSchemas.ts` before the adapter reads it. A body that does not match raises `UpstreamError` with kind `contract` (never retried) and the run ends `FAILED` with the reason; nothing is defaulted into a valid value. Two absent fields keep a cautious meaning on purpose: an absent HIE payload hash means "not verified" (policy R4, manual review), and an absent MPI confidence means "probable" (ambiguous match). A 409 from the Task write counts as a version conflict only when its body matches the conflict schema. Fault configs sent to `PUT /api/faults/:key` are validated too.

## Known differences from real systems

- Resource shapes are FHIR-*like*; no US Core / CARIN BB / PDex / Da Vinci profile validation.
- Payload hash is SHA-256 hex in an extension (FHIR `attachment.hash` is base64 SHA-1).
- Real attribution, opt-out granularity, HIE trust frameworks (e.g. Carequality/TEFCA), SMART Backend Services auth and payer-specific APIs are not modelled.
- Prior-auth draft is a custom resource; real EHRs model this differently per vendor.
- One shared SQLite file (schema-separated) instead of independent systems.
