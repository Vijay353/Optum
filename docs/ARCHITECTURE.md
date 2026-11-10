# Architecture

## Topology (SIMULATED mode)

One local Node.js process hosts four behavioral simulators, the orchestrator API and (in production mode) the built React UI. The orchestrator reaches the simulators **over real HTTP** through typed adapters, so the code path is the same one that would call remote systems.

```
 Browser (React)                                Node process :8787
 ┌───────────────────────┐   /api/*    ┌─────────────────────────────────────────────────────────────┐
 │ EvidenceBridgePage    │ ──────────▶ │ API (src/server/app.ts) — demo identity, role checks         │
 │ TechnicalInspector    │             │   │                                                         │
 │ CitationViewer        │             │   ▼                                                         │
 │ DataStudio            │             │ Orchestrator ──▶ FixtureEvidenceExtractor (no tools, no I/O) │
 └───────────────────────┘             │   │  policy EVID-1.0 (pure)  ·  patient match  ·  integrity  │
                                       │   │  createEvidenceReviewTask (role + policy gate)            │
                                       │   ▼  adapters (HTTP client: timeout, bounded retry, jitter)   │
                                       │ ┌────────────┬──────────────────┬────────────┬─────────────┐ │
                                       │ │ /mock-ehr  │ /mock-payer      │ /mock-hie  │ /mock-policy│ │
                                       │ │ EHR/FHIR   │ Provider Access  │ HIE docs   │ synthetic   │ │
                                       │ │ R/W (Task) │ read-only        │ read-only  │ checklist   │ │
                                       │ └─────┬──────┴────────┬─────────┴─────┬──────┴──────┬──────┘ │
                                       │       ▼               ▼               ▼             ▼        │
                                       │   SQLite file — ehr_* · payer_* · hie_* · policy_* · app_*   │
                                       └─────────────────────────────────────────────────────────────┘
```

## Execution pattern

`TRIGGER → AUTHORIZED CONTEXT → EXTRACTION → INDEPENDENT POLICY → HUMAN CONFIRMATION → TOOL → PERSIST → READ-BACK → AUDIT`

| Phase | Function | Writes |
|---|---|---|
| Evaluate | `processPriorAuthDraft` (spec §8 steps 1–10) | Run record + app audit only |
| Execute | `executeStagedTask` (steps 11–13), triggered by **Stage evidence review task** | One Task + draft status (EHR, one transaction) |

The evaluate phase stops before any external retrieval when the draft or policy version is stale, and before claims/HIE retrieval when access is denied.

**Pre-write re-check (V3 CH-0A).** Right after the PA specialist confirms, and before the tool is called, the execute phase checks two things again: (1) the evaluation is not older than `EB_MAX_RUN_AGE_HOURS` (default 24), and (2) the payer still permits Provider Access for this patient and provider (attribution and opt-out). If either fails, nothing is written. A run that is too old ends `REEVALUATION_REQUIRED`; lost access ends `ACCESS_NOT_PERMITTED`; an access check that does not respond ends `FAILED_RETRYABLE`. The draft version and policy version are still checked by the EHR inside the write transaction.

## Time (V3 CH-0B)

Business time comes from one `Clock` bound to the database (`bindClock`, `nowIso(db)`). In the app this is the **scenario clock**: each scenario fixture sets `scenarioTime` (all shipped fixtures use `2026-10-18T13:10:00Z`, the spec's event time). Loading a scenario starts the clock there; it then moves with real elapsed time, plus any demo offset from `POST /api/clock/advance` (forward only). Event times, lookback windows, claim filtering, due dates, run age, task and audit timestamps all use it, so results do not change with the calendar. Tests can inject a `ManualClock`. Operational log lines keep real wall time on purpose. A fixture without `scenarioTime` uses the system clock. An existing local database created before CH-0B uses the system clock until the scenario is loaded again (`npm run seed` or "Load & reset").

## Review due state (V3 CH-5, refined)

EvidenceBridge has no approver queue, so CH-5 applies to the review Task it creates. Each Task carries a due time (`restriction.period.end`, 48 hours after the event). `GET /api/workspace` returns `taskDue` for each Task, derived on read by `src/domain/reviewDue.ts` from that due time and the scenario clock: `ON_TIME`, `DUE_SOON` (12 hours or less) or `OVERDUE` (at or after the due time). Reading it writes nothing. An overdue review stays with `pa-specialist-queue`; no other role gains rights and nothing is staged or sent automatically.

## More than one candidate document (V3 CH-6, policy EVID-1.1)

The HIE search already narrows to the lead clinic, the PT discharge-summary type and the claim period. If it still returns more than one document, the run records every candidate (`run.candidates`, with ids, dates and hashes) and policy EVID-1.1 rule `R5_MULTIPLE_CANDIDATES` returns `MANUAL_REVIEW`: no task, nothing staged, a person decides which document applies. The UI lists the documents, says what matched, and notes that this is often a normal amended copy. Different clinics, other document types and periods outside the claim window are not flagged. The demo case is the opt-in scenario `possible-duplicate-document`, which adds an overlay (`fixtures/overlays/second-pt-summary`) on top of the unchanged base dataset.

## Clinic history (V3 CH-8)

Card 2 shows one plain line: EvidenceBridge's own history with the clinic the claim leads point to, over the last 90 days of scenario time (`src/persistence/sourceHistory.ts`, read from `app_runs`). One draft counts once, by its latest check; the current draft is excluded; checks that never reached claims belong to no clinic. Buckets: review task created, sent to manual review, waiting to be staged, ended with no task. They always add up to the drafts counted. It is not external master data and shows no trend.

## Evidence checks (V3 CH-19)

`src/orchestrator/evidenceChecks.ts` turns the persisted run record into 16 checks (local chart, draft and policy versions, sources responded, Provider Access, claim leads, document found, single candidate, hash, patient match, extractor output, citations, lookback, pre-write re-check, task write, read-back). It reads the values the policy actually received and the trace; it does not re-run the policy. Each check is PASS, WARN (a person must look), FAIL, or NOT_EVALUATED (did not run, never shown as passed), with evidence references, time and rule version. The workspace returns it; the browser only displays it. Tests check, for every scenario, that the matrix agrees with the decision, the outcome and the trace.

## Ports (V3 CH-1)

The orchestrator and the API read external systems only through typed ports in `src/adapters/ports.ts` (`EhrPort`, `ProviderAccessPort`, `HiePort`, `PolicyPort`, and the SIMULATED-only `SimulatorProbePort`). The workspace screen reads the draft and its Tasks with `EhrPort.getDraft` and `EhrPort.listTasksForDraft`. Direct SQL on `ehr_*`, `payer_*`, `hie_*` and `policy_versions` exists only in the owning simulator, its persistence helpers, and the Data Studio seeding module (`src/data`); `tests/ch1.ports.test.ts` fails the build otherwise. The one remaining direct call is the demo "another user edits the draft" control, which acts as a demo clinician on the simulator and is not a domain read.

## Data ownership

| Owner | Tables | Writable by orchestrator? |
|---|---|---|
| Mock EHR | `ehr_patients`, `ehr_coverage`, `ehr_service_requests`, `ehr_documents`, `ehr_prior_auth_drafts`, `ehr_tasks`, `ehr_idempotency`, `ehr_audit`, `ehr_outbox` | Only via `POST /fhir/Task` (Task + draft status, atomic) |
| Mock Provider Access | `payer_attribution`, `payer_opt_out`, `payer_eob`, `payer_access_log` | No — read-only, no write routes exist |
| Mock HIE | `hie_documents`, `hie_binaries`, `hie_access_log` | No |
| Synthetic policy | `policy_versions` | No |
| Orchestrator | `app_runs`, `app_audit`, `app_import_batches`, `app_meta` | Yes |
| Control plane | `sim_faults` | Scenario/fault API only |

Each simulator module touches only its own prefix. One SQLite file lets Data Studio commit imports atomically across simulators — a demo convenience independent real systems would not offer.

## Transaction boundaries and consistency

- **Task creation** — one `BEGIN IMMEDIATE` transaction in the EHR: version check, transition check, Task insert, draft status update, idempotency record, audit rows, chart-fingerprint invariant. Any failure rolls back everything.
- **Idempotency** checked before the version check, so a replay returns the original result (`duplicate: true`) even though the draft has moved on.
- **Optimistic concurrency** — `expectedDraftVersion` must equal the draft's current content version; otherwise `409 VERSION_CONFLICT`, the orchestrator reloads the draft and ends in `REEVALUATION_REQUIRED`.
- **Partial failure** — if the EHR commits but the response is lost, the adapter retries with the same idempotency key and receives the stored result; no second Task.
- **Readback** — Task and draft are fetched independently and compared field by field (16 checks, plus a payer-write count). A mismatch marks the run `FAILED`; the UI never shows success. The Task may exist; that is stated.
- **Cross-system** — the orchestrator never writes to the payer or HIE, so no compensation is needed. Real deployments would add an outbox for event delivery; the simulator keeps a per-event outbox with delivery counts.

## Trust boundaries

1. **Browser ↔ API** — demo identity header (`x-demo-role`), *not* authentication. Document pages are returned only to the PA specialist role.
2. **Orchestrator ↔ simulators** — static local bearer tokens with scopes. The orchestrator holds read scopes plus `Task.write`; no `Draft.write`, no document write, and the payer exposes no submission route.
3. **Untrusted content** — HIE document text, workbook cells and simulator responses are data. The extractor has no tool access; its output is schema-validated (strict, prohibited keys, verdict language) and every quote is re-verified against the source offsets. Instruction-like text is flagged and ignored.
4. **Secrets** — server-side only (`.env`); `scripts/checkClientBundle.ts` fails the build if tokens or provider code appear in `dist/`.
5. **Visitor access gate (V3 CH-20)**, `src/server/accessGate.ts`. A separate, outer boundary in front of everything above. When on, every request needs a valid session except `GET /healthz`, `GET /gate`, `POST /gate/login` and `POST /gate/logout`. That covers the app document and deep links (redirected to `/gate?next=<same-site path>`), the built JS and CSS, the API and the simulator routes (401 JSON with `gate: true`). The gate page is plain server HTML with an inline style and a small inline script under a nonce CSP (`default-src 'none'`); it loads nothing else, so no analytics can run on it. The PIN is a runtime secret (`EB_ACCESS_PIN`), compared as an HMAC in constant time, never logged and never in the client bundle. A correct PIN sets a signed (HMAC-SHA256), short-lived, `HttpOnly`, `SameSite=Lax` cookie, `Secure` whenever the server is not on loopback. Logout revokes that token in memory and clears the cookie. Failures get one generic message and a progressive per-client delay (after 3 failures: 1 s, doubling, capped at 15 minutes) plus a global cap (60 failures in 15 minutes blocks everyone for the rest of the window), because client addresses can rotate. The client address comes from the socket unless `EB_TRUST_PROXY` names the number of trusted proxies. In-process simulator calls pass with a random per-process key that is accepted only from loopback. The gate may be off only when the server listens on loopback (local development, tests); on any other address it is required and bad settings stop the server at startup. It is unrelated to the demo role switch: passing the gate gives no role, and the role switch never opens the gate. **Limits:** four digits are 10,000 combinations; the delays slow guessing but this is a convenience gate for a synthetic demo, not authentication for real data. Revocation is in memory and is lost on restart (tokens still expire).
6. **Analytics (V3 CH-21)**, `src/ui/analytics.ts`. Optional Microsoft Clarity. The project id is a runtime setting (`EB_CLARITY_PROJECT_ID`) returned by `/api/health` only when the access gate is on, so a browser learns it only after entry; the gate page is server HTML that never runs app code. Inside the app, nothing loads until the visitor chooses "Allow analytics" (Clarity still tracks in a cookieless mode when consent is denied, so the script is not loaded at all without a yes). After Allow, the official loader pattern adds `https://www.clarity.ms/tag/<id>` once per page load and sets `consentv2` with analytics storage granted and ad storage denied. Events are five fixed names with no values (`project_entered` once per browser session, `scenario_started`, `evidence_check_run`, `scenario_completed`, `audit_export_clicked`); no record ids, names, roles, free text, errors or passcodes. `<main>` carries `data-clarity-mask="true"`, so review content is masked in recordings. "Turn off analytics" sends `consentv2` denied and `consent(false)` (Clarity clears its cookies), then reloads so the script is gone. Off on localhost and under browser automation unless the server sets `EB_ANALYTICS_ALLOW_LOCAL=true` for a test. No fingerprinting, no identify calls, no custom tags. Consent choice is kept in `localStorage`; if storage is blocked, the choice lasts for the page only.

## Logging and audit

Application logs are JSON lines with synthetic patient/coverage identifiers masked and no document bodies (`src/server/logger.ts`). Audit tables are append-only (no update/delete API) and hold identifiers and hashes, not clinical text.

**Hash chain (V3 CH-17).** Every new row in `ehr_audit` and `app_audit` stores `prev_hash` and `entry_hash` (SHA-256 over a length-framed encoding of its fields, algorithm `EB-AUDIT-CHAIN-1`, genesis = 64 zeros), written in the same savepoint as the row. The newest hash is kept as a head anchor in `app_meta`. `GET /api/audit/verify` (and "Verify audit chain" in the inspector) reports per table: OK, change detected at row N, no rows, or not verifiable. It detects edited rows, deleted middle rows, removed hashes and deleted last rows. Rows written before CH-17 have no hash and are reported as not verifiable. **Limits:** anyone with write access to the database file can recompute the chain and the anchor. It is not signed, not anchored outside this database, not immutable and not a certification.

**Audit evidence package (V3 CH-18).** `GET /api/runs/:id/evidence-package` (PA specialist and simulator admin only; viewer gets 403; fails closed on configuration errors) returns one JSON file built only from persisted records: the event, draft before and after, the recorded policy input and result, the coverage policy as recorded at decision time, access checks at evaluation and before the write, claim lead ids, candidate and selected document ids and hashes, extraction hash and fact locations (values and offsets, never the quoted text), the 16 evidence checks, tool input and result, read-back checks, the trace, the run's `app_audit` rows and the related `ehr_audit` rows with their chain hashes, and the chain verification report. `evidenceStatus` is `complete`, `partial` (a named gap, for example a read-back that did not match) or `unverifiable` (the chain did not verify or an included row has no hash). The `digest` is SHA-256 over the canonical JSON without the digest field; `scripts/verifyEvidencePackage.ts` checks it. It is a checksum, not a signature, and the package is not a compliance certification.

## Deployment topology (V3 CH-22)

One container, one Node process, one origin: built UI, API and simulators. SQLite on a mounted `/data` volume, single writer, no replicas. The server binds `EB_HOST` (loopback locally, `0.0.0.0` in the container); simulator calls inside the process always use `127.0.0.1`. Startup refuses an unwritable data directory and never reseeds a database that has records. `GET /healthz` is a read-only readiness check. Backups use the SQLite online backup API and are checked by opening the copy. Steps and limits: `DEPLOYMENT.md`.

## Production path

Replace the four SIMULATED adapters with real ones behind the same ports (`src/adapters/ports.ts`); domain, policy, tool and UI code stay unchanged. See `INTEGRATIONS.md`.
