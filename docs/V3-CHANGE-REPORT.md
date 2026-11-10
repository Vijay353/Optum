# EvidenceBridge V3 change report

Spec: `docs/UNIVERSAL-V3-SPEC.md`. Branch `enhance/evidencebridge-v3`, baseline tag `v3-baseline` (`809c0b1`). All data is synthetic. Nothing was pushed, published or deployed.

Status labels: PASSED, DEFERRED, BLOCKED. Deployment labels: CONFIGURED, TESTED_LOCALLY, LIVE_VERIFIED.

**Summary.** 19 of 22 changes PASSED. 3 were DEFERRED with a reason (CH-3, CH-4, CH-9: the mechanisms they add do not exist in this domain, or need a navigation change the spec rules out). Nothing is BLOCKED. Deployment is TESTED_LOCALLY in a local container and CONFIGURED for a live server; it is not LIVE_VERIFIED. You asked for "all PASSED"; for the three deferred items that would have meant building features with nothing to attach to, and the spec allows DEFERRED with a reason (Appendix A.4).

## 1. Baseline versus final

| Check | Historical (TEST-REPORT, 2026-10-18) | Observed baseline (2026-11-09, this session, `809c0b1`) | Final (2026-11-09, this session) |
|---|---|---|---|
| `npm run typecheck` | pass | pass | pass |
| `npm run lint` | 0 problems | 0 problems | 0 problems |
| `npm test` | 7 files, 91 tests | 7 files, 91 passed | **29 files, 266 passed, 0 failed** |
| `npm run build` | pass, JS 260 kB (80 kB gzip) | pass, JS 259.58 kB (79.93 kB gzip) | pass, JS 282.88 kB (86.95 kB gzip) |
| `npm run check:bundle` | 3 files, 0 forbidden | 3 files, 0 forbidden | 3 files, 0 forbidden (pattern list extended for CH-20) |
| `npm run demo:cli` | 15/15 scenarios | not logged separately | **16/16** (15 base unchanged + 1 opt-in) |
| `npx playwright test` | 5 passed | not logged separately; the first V3 run (CH-0A) showed 6 = 5 existing + 1 new | **27 passed** |

Baseline logs: typecheck, lint, test, build and bundle were run at the start of this session and saved. I did not keep a separate baseline E2E log; the five original browser tests passed unchanged in every later run.

Browser note: the Playwright browser download is blocked in this environment, so every E2E run used `EB_CHROMIUM_PATH` pointing at a Chromium binary from npm (`@sparticuz/chromium`, not a project dependency).

Per-file test counts in the final run: original files `domain.unit` 32, `import` 19, `llmExtractor` 3, `scenarios` 16 (was 15; the opt-in CH-6 scenario adds one case), `security` 3, `vslice.primary` 2, `workflow.reliability` 17. New files: `ch0a` 7, `ch0b` 10, `ch1` 9, `ch2` 13, `ch5` 3, `ch6` 10, `ch7` 4, `ch8` 3, `ch10` 5, `ch11` 2, `ch12` 5, `ch13` 3, `ch14` 21, `ch15` 4, `ch16` 3, `ch17` 8, `ch18` 8, `ch19` 21, `ch20` 12, `ch21` 9, `ch22` 8, `v3.invariants` 6.

**Defect found by the packaging check.** Running the browser suite repeatedly from the unzipped package showed that three CH-20 and CH-21 browser tests depended on leftover demo state: they passed on a fresh database and failed when the gate-on test database was reused (a "Run evidence check" button that is absent once a check exists, and a `name: "Evidence review"` locator that also matched "Stage evidence review task"). The product behaved correctly in every failure; the tests were wrong. Fix (commit "test: make gate and analytics browser tests independent of leftover state"): the analytics test resets the scenario through the API first, the locators use exact names, a gate test waits for the first data load before expiring the session, and the gate-on test server starts from a fresh database file. Afterwards, six consecutive full runs in the unzipped copy with state kept between runs all passed 27/27.

No existing assertion was changed to make a test pass. Two test helpers were adjusted with a reason in the same commit: CH-0B made the CH-0A helper age a run relative to its own timestamp (it used the wall clock), and CH-21 made two CH-20 browser tests wait for the app tabs instead of a button whose label depends on shared demo state.

## 2. Change register

Full rows, with test evidence, are in `docs/IMPLEMENTATION-STATUS.md` ("V3 change register"). Every change is one commit and can be undone with `git revert <sha>`.

| ID | Status | Commit | What changed (files) | Tests |
|---|---|---|---|---|
| CH-0A Re-check access and run age before the write | PASSED | `cc718c2` | `orchestrator/processPriorAuthDraft.ts` (pre-write re-check), `server/config.ts` (`EB_MAX_RUN_AGE_HOURS`) | `ch0a` 7, E2E 1 |
| CH-0B Fixed scenario clock per fixture | PASSED | `2637b78` | `persistence/scenarioClock.ts`, `db.ts` (`bindClock`, `nowIso`), every `scenario.json` (`scenarioTime`), `/api/clock` | `ch0b` 10, E2E 1 |
| CH-1 Domain reads through the port | PASSED | `349760a` | `adapters/ports.ts`, `MockSimulatorProbeAdapter.ts`, workspace route | `ch1` 9 (includes an architecture scan) |
| CH-2 Typed payload accessors | PASSED | `3939e14` | `adapters/wireSchemas.ts`, `http.ts` (`requestParsed`, contract errors never retried) | `ch2` 13 |
| CH-3 Summary counters | DEFERRED | `1cd2850` | Register row only. No counter feeds any decision, and the task write and run record are separate transactions | none |
| CH-4 Multi-part allocations and undo | DEFERRED | `d28ee68` | Register row only. One Task, no parts or amounts, no undo path exists | none |
| CH-5 Review overdue flag (refined from approval SLA) | PASSED | `10fb801` | `domain/reviewDue.ts`, derived on read | `ch5` 3, E2E 1 |
| CH-6 Possible duplicate document (refined from duplicate resubmission) | PASSED | `33478e9` | Policy EVID-1.1 rule `R5_MULTIPLE_CANDIDATES`, opt-in scenario `possible-duplicate-document` | `ch6` 10, E2E 1 |
| CH-7 Read-only staging projection | PASSED | `0a32d4c` | `ui/projection.ts` | `ch7` 4, E2E 1 |
| CH-8 Trailing history with the source clinic | PASSED | `f419d56` | `persistence/sourceHistory.ts` | `ch8` 3, E2E 1 |
| CH-9 Per-item bulk approvals | DEFERRED | `0b92bf5` | Register row only. Single-draft workspace, no queue; adding one is a navigation change | none |
| CH-10 Comparison bars | PASSED | `1a158f2` | `ui/compare.ts` | `ch10` 5, E2E 1 |
| CH-11 Collapsible check history | PASSED | `5ef3450` | `runStore.listRunSummariesForDraft`, disclosure | `ch11` 2, E2E 1 |
| CH-12 Source-labelled badges | PASSED | `cba02b3` | `ui/badges.ts` | `ch12` 5, E2E 1 |
| CH-13 Inline demo role switch | PASSED | `47d4c49` | `ui/roleSwitch.ts` | `ch13` 3, E2E 1 |
| CH-14 Lifecycle stepper from real statuses | PASSED | `1043534` | `ui/stepper.ts` | `ch14` 21, E2E 1 |
| CH-15 Truthful empty states | PASSED | `728123c` | `ui/emptyStates.ts` | `ch15` 4, E2E 1 |
| CH-16 Policy provenance | PASSED | `6c68563` | `ui/provenance.ts`, optional effective dates in run context | `ch16` 3, E2E 1 |
| CH-17 Audit hash chain | PASSED | `1ccfb0e` | `persistence/auditChain.ts`, `GET /api/audit/verify` | `ch17` 8, E2E 1 |
| CH-19 Evidence verification matrix | PASSED | `8733263` | `orchestrator/evidenceChecks.ts` (done before CH-18 so the package can include it) | `ch19` 21, E2E 1 |
| CH-18 Audit evidence package | PASSED | `5e04abc` | `orchestrator/evidencePackage.ts`, `GET /api/runs/:id/evidence-package`, `scripts/verifyEvidencePackage.ts` | `ch18` 8, E2E 1 |
| CH-22A Container and persistence dry run | PASSED, deployment TESTED_LOCALLY | `5eee9ab` | `Dockerfile`, `.dockerignore`, `server/bootstrap.ts`, `persistence/backup.ts`, `scripts/bootstrap.ts`, `scripts/backupDb.ts`, `/healthz`, `docs/DEPLOYMENT.md` | `ch22` 8, local container run |
| CH-20 Four-digit access gate | PASSED, deployment TESTED_LOCALLY | `da8fab4` | `server/accessGate.ts`, `config.ts`, `app.ts`, `adapters/http.ts` (in-process header), UI lock button | `ch20` 12, E2E 4 |
| CH-21 Analytics after entry and consent | PASSED, CONFIGURED (no project id given) | `0345e79` | `ui/analytics.ts`, consent notice, masking on `<main>` | `ch21` 9, E2E 2 |
| CH-22B Authorized live deploy | CONFIGURED, not done | none | Manual steps in `docs/DEPLOYMENT.md` | needs your server, domain, PIN and authorization |

Order note: the spec's safe deployment order (CH-22A, then CH-20, then CH-21, then CH-22B) was followed.

Documentation changed along the way: `README.md`, `docs/ARCHITECTURE.md` (V3 sections for every structural change), `docs/SIMULATOR-CONTRACTS.md` (clock API, probe route, response validation), `docs/DEPLOYMENT.md` (new), `.env.example`, `docs/IMPLEMENTATION-STATUS.md` (register), `docs/TEST-REPORT.md` (V3 section).

## 3. Invariant evidence

The spec's invariants are written for a generic approval product. Here is each one mapped to this domain, with the test that proves it.

| Invariant | In this project | Evidence |
|---|---|---|
| One guarded binding write | The only write is `createEvidenceReviewTask` (`POST /mock-ehr/fhir/Task`). The tool checks role, policy decision, staged input, CH-0A re-check, idempotency key and expected draft version. No import, simulator control or UI path writes a Task | `vslice.primary`, `workflow.reliability` ("cannot stage a run twice", "no Draft.write scope"), `ch1` architecture scan |
| Forged role rejected | Unknown or malformed `x-demo-role` values become read-only viewer; viewer gets 403 on check and stage; no Task is written | `v3.invariants` 6 cases; `vslice.primary` viewer negative; E2E viewer negative |
| Stale revision rejected | `expectedDraftVersion` mismatch gives 409 and `REEVALUATION_REQUIRED`, no Task | `workflow.reliability` Example H and stale event; demo `stale-version` |
| Idempotent replay | Same event or lost response returns the same Task with `duplicate: true`; one Task, one audit write | `workflow.reliability` Example G and lost response; `ch17` replay adds no duplicate audit row; container restart re-stage refused with no second Task |
| Per-part bounds | Not applicable: no parts, quantities or money (CH-4 deferred) | register CH-4 |
| Message freshness | A checked run older than `EB_MAX_RUN_AGE_HOURS` (default 24) cannot be staged; consent and attribution are re-checked immediately before the write | `ch0a` 7, `ch0b` (scenario clock), E2E CH-0A and CH-0B |
| Fail closed outside simulation | SANDBOX or LIVE without verified adapters refuses to run and never falls back; LLM extractor without a key fails closed; a response that breaks the wire contract fails the run instead of looking like "source unavailable" | `workflow.reliability` SANDBOX and LLM cases; `ch2` 13 |
| Compensating reversal | Not applicable: no undo path exists. If one is added it must be a compensating Task status change with an audit row | register CH-4 |
| Original demo integrity | Base fixtures unchanged; `primary-success` still writes `TASK-EVID-1042` with 16/16 read-back; the 15 base scenarios give the same decisions and outcomes; the new scenario is opt-in | demo:cli 16/16; `scenarios` 16; `ch6` "base fixture unchanged" |
| Warnings never auto-act | A second candidate document (CH-6), an ambiguous match or an abstaining extractor always yields MANUAL_REVIEW and no Task; the evidence matrix (CH-19) never shows a blocking check as passed | `ch6`, `ch19` 21 (every scenario: blocking checks agree with the decision) |
| Demo identity is not authentication | Labelled in the UI ("demo identity"), in the API code and in docs. The CH-20 gate is a separate boundary and gives no role | `ch20` "role switch stays a separate check" |

## 4. Migrations

All schema changes are additive and run on open (`openDb`).

- **CH-17:** `prev_hash` and `entry_hash` columns on `ehr_audit` and `app_audit`, plus head anchors in `app_meta`. Tested on a fresh database and on a database file created before CH-17 (`ch17` "legacy database migration and restart"). Rows written before CH-17 have no hash; the verifier reports them as not verifiable instead of guessing.
- **CH-0B:** `app_meta` keys for the scenario clock. Missing keys mean the system clock, so older databases still open.
- **CH-0A, CH-16, CH-6:** new optional fields inside the run JSON. Older runs without them render as "not recorded" (CH-16 test covers this).
- **CH-22:** no schema change. Startup never reseeds a database with records; tested on a real process restart (`ch22`) and on container restart and redeploy with the same volume.

Compatibility: a V3 database can be read by an older V3 commit (it ignores unknown columns and keys). Going back to the pre-V3 baseline image is not supported automatically; restore a backup taken before the upgrade. There is no automatic reverse migration.

## 5. Explicitly rejected

- New infrastructure: no queue, cache, broker, ORM, PostgreSQL or second service. SQLite stays, single writer.
- New dependencies: none. `tsx` moved from dev to production dependencies at the same version because the server runs from TypeScript source.
- New model provider or autonomous agent behavior: none. The deterministic extractor stays the default.
- UI overhaul or navigation change: none. CH-9 bulk approvals were deferred because they need a queue view.
- Unattended action: overdue reviews (CH-5) and possible duplicates (CH-6) only flag; nothing is approved or written automatically.
- Identity or signature fiction: the evidence package digest is called a checksum, not a signature; the hash chain is called tamper-evident against simple edits, not immutable; the access gate is called a convenience gate, not authentication; the demo role switch stays labelled as demo identity.
- Analytics fingerprinting, identify calls, custom tags or event values: none.

## 6. Known limitations

- All external systems (EHR, payer Provider Access, HIE, policy) are local simulators. No vendor connectivity is claimed.
- Demo roles come from a request header. A request without the header acts as the PA specialist (the demo default). This is not authentication.
- The hash chain lives in the same database. Anyone who can write the file can recompute it and the anchor. It is not signed or anchored elsewhere.
- Audit rows written before CH-17 cannot be verified.
- The evidence package digest proves the file was not changed after export; it does not prove who exported it.
- The access gate is four digits (10,000 combinations). Delays and a global cap slow guessing; that is all. Session revocation is in memory and is lost on restart (tokens still expire, 2 hours by default).
- Analytics is configured but not connected: no Clarity project id was provided. The loader was tested against a local stub of `clarity.ms`, not against Microsoft's service. Confirm the tracking URL against your Clarity dashboard before enabling.
- The container was built and tested on a stand-in base image assembled from this machine's Node 22.22.0, because Docker Hub is blocked here. The Dockerfile's default base image (`node:22.22.0-bookworm-slim`) has not been pulled or tested.
- No usability study was run (see section 9).
- Deferred: CH-3, CH-4, CH-9, with reasons in section 2.
- No revenue, time-saved, compliance or detection-rate claims are made.

## 7. Demo walkthrough

Local: `npm install`, `npm run dev`, open http://localhost:5173. Everything below is synthetic and simulated.

1. **Primary path.** Scenario "1. Primary success", Load and reset, Run evidence check. Checkpoints: the stepper reaches "Needs your confirmation"; the evidence check line shows 13 passed and 3 not evaluated (the write steps have not happened, so they are not shown as green); the projection shows exactly what one write would create. Stage evidence review task. Checkpoints: Task `TASK-EVID-1042`, draft `DRAFT_INCOMPLETE` to `EVIDENCE_REVIEW_PENDING`, 16/16 read-back checks, evidence checks now 16 passed.
2. **Freshness.** Demo controls, move scenario time forward 25 hours, then Stage: refused, nothing written. Opt-out recorded after the check: Stage is refused by the pre-write re-check.
3. **Possible duplicate (opt-in).** Scenario "possible duplicate document": MANUAL_REVIEW, rule `R5_MULTIPLE_CANDIDATES`, no Task.
4. **Audit.** Technical evidence, Verify audit chain: both tables OK. Export audit evidence package: a JSON file with status Complete; `npx tsx scripts/verifyEvidencePackage.ts <file>` confirms the checksum. On a throwaway copy, editing one audit row makes the chain report the row and the package say Unverifiable (shown in `ch17` and `ch18` tests).
5. **Hosted copy (when deployed).** A passcode screen first; a deep link returns to the same page after entry; "Lock demo" returns to the passcode screen. If analytics is configured, a one-line choice appears after entry and nothing loads until Allow.

## 8. Interview explanation

A clinician's prior-authorization draft is missing physical therapy documentation. The EHR simulator emits `PriorAuthDraftCreated`. The orchestrator loads the draft and policy through ports (CH-1), validates every response against a wire schema (CH-2), and checks Provider Access consent and attribution before asking for any data. Claims are leads only. It retrieves the HIE document, verifies its SHA-256, matches the patient, and runs a deterministic extractor whose output must carry exact citations that are re-checked against the source offsets. A pure policy function (EVID-1.1) decides; only `REVIEW_EXTERNAL_EVIDENCE` allows a write, and it means "a person should review this", never "criteria met".

The write waits for a person. When they confirm, the tool re-checks consent, attribution and run age immediately before calling the EHR (CH-0A), sends one `createEvidenceReviewTask` with an idempotency key and the expected draft version, and the EHR commits the Task and the draft status change in one transaction. Then an independent read-back compares 16 facts, plus a payer write count that must still be zero. Every step lands in the trace and in hash-chained audit rows (CH-17). The evidence matrix (CH-19) is derived from what actually ran, and the export (CH-18) packages it.

Failure paths: a source timeout gives SOURCE_UNAVAILABLE with no write; a concurrent draft edit gives 409 and REEVALUATION_REQUIRED; a lost response is retried with the same key and replays the same Task; a contract violation fails the run rather than pretending the source was down. Bulk operations were not built (CH-9); if they are, each item must go through the same tool so per-record authority holds item by item.

## 9. Product validation

Targets from the spec (section 6.3): the 30-second rule, the one-sentence rule, plain words first, progressive disclosure, honest states.

Observed: no usability exercise with people was run, so none of these targets is claimed as met. What exists is automated evidence for parts of them: plain-word labels and words beside every colored status (CH-12 E2E), the technical inspector collapsed by default, keyboard operation of disclosures and the stepper (E2E), no horizontal scroll on a phone width (E2E for the app and the gate), and the gate and analytics notice checked by screenshot at desktop and phone width. A five-person hallway test against the four questions would be the next step.

## 10. Deployment and analytics evidence

- **Container (CH-22A): TESTED_LOCALLY.** Image built with the repository Dockerfile (`npm ci`, UI build and bundle scan inside the build) on a stand-in Node 22.22.0 base. Observed: `/healthz` 200; first start on an empty volume seeded once; UI document, deep link and assets served; the primary scenario wrote `TASK-EVID-1042` with read-back true; restart and redeploy on the same volume kept the Task and logged `Existing database. No reseed on restart.`; re-staging after restart was refused (403, nothing to stage) and the Task count stayed 1; both audit chains OK; backup inside the container matched the source; a read-only volume made the container exit 1 with a clear message. The image contains no `.env` and no database file.
- **Access gate in the container (CH-20): TESTED_LOCALLY.** No PIN on `0.0.0.0` refused to start (exit 1); `EB_ACCESS_GATE=off` on `0.0.0.0` refused to start; without a session `/` and a deep link redirected to the gate, the API returned 401 JSON, a simulator route returned 401, a built JS asset returned 401; a wrong PIN returned 401 with the generic message; the right PIN returned 303 to the deep link with `HttpOnly; SameSite=Lax; Max-Age=7200; Secure`; with the session the API, document and asset returned 200 and the primary scenario completed; logout redirected to the gate and the old cookie then got 401; the PIN appeared 0 times in logs and 0 times in served files.
- **Analytics (CH-21): CONFIGURED.** Browser tests with `clarity.ms` answered by a local stub observed zero analytics requests on the gate and after a wrong PIN, zero before Allow, one after, one per page load, only the five approved event names with no ids, and the Clarity deny and cookie-clear calls on withdrawal. `<main>` carries `data-clarity-mask="true"`. No project id was provided, so nothing has reached a real dashboard.
- **Live deploy (CH-22B): CONFIGURED, not done.** No server, domain, PIN or authorization was provided. There is no deployed URL. Steps, firewall notes, backups, restore test and rollback are in `docs/DEPLOYMENT.md`.

Sources used for the deployment and analytics setup: [Coolify installation](https://coolify.io/docs/get-started/installation), [Coolify firewall guide](https://coolify.io/docs/core/infrastructure/servers/firewall), [Microsoft Clarity client API](https://learn.microsoft.com/en-us/clarity/clarity-api), [Clarity Consent API v2](https://learn.microsoft.com/en-au/clarity/clarity-consent-api-v2).

## 11. Verbatim command evidence

Final run on 2026-11-09 at commit `0345e79` plus the `v3.invariants` test, Node v22.22.0, Linux. Output trimmed only to the result lines.

```text
$ npm run typecheck
> optum-evidencebridge@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json
(exit 0)

$ npm run lint
> optum-evidencebridge@0.1.0 lint
> eslint .
(exit 0)

$ npm test
 Test Files  29 passed (29)
      Tests  266 passed (266)
   Duration  36.85s

$ npm run build
dist/assets/index-y-YZwIDP.css   17.75 kB │ gzip:  4.34 kB
dist/assets/index-Jtfpd_Xf.js   282.88 kB │ gzip: 86.95 kB
✓ built in 189ms

$ npm run check:bundle
Client bundle clean: 3 files scanned, 0 forbidden patterns.

$ npm run demo:cli
PASS  primary-success      decision=REVIEW_EXTERNAL_EVIDENCE  outcome=EVIDENCE_REVIEW_PENDING  status=COMPLETED              tasks=1
PASS  claims-only          decision=CLAIM_LEAD_ONLY           outcome=CLAIM_SOURCE_FOLLOWUP    status=NO_ACTION              tasks=0
PASS  opt-out              decision=ACCESS_NOT_PERMITTED      outcome=ACCESS_NOT_PERMITTED     status=NO_ACTION              tasks=0
PASS  no-attribution       decision=ACCESS_NOT_PERMITTED      outcome=ACCESS_NOT_PERMITTED     status=NO_ACTION              tasks=0
PASS  ambiguous-match      decision=MANUAL_REVIEW             outcome=MANUAL_REVIEW            status=NO_ACTION              tasks=0
PASS  patient-mismatch     decision=INSUFFICIENT_EVIDENCE     outcome=MANUAL_REVIEW            status=NO_ACTION              tasks=0
PASS  prompt-injection     decision=REVIEW_EXTERNAL_EVIDENCE  outcome=EVIDENCE_REVIEW_PENDING  status=COMPLETED              tasks=1
PASS  policy-superseded    decision=INSUFFICIENT_EVIDENCE     outcome=REEVALUATION_REQUIRED    status=NO_ACTION              tasks=0
PASS  source-unavailable   decision=SOURCE_UNAVAILABLE        outcome=SOURCE_UNAVAILABLE       status=NO_ACTION              tasks=0
PASS  hie-unavailable      decision=SOURCE_UNAVAILABLE        outcome=SOURCE_UNAVAILABLE       status=NO_ACTION              tasks=0
PASS  hash-mismatch        decision=MANUAL_REVIEW             outcome=MANUAL_REVIEW            status=NO_ACTION              tasks=0
PASS  stale-version        decision=REVIEW_EXTERNAL_EVIDENCE  outcome=REEVALUATION_REQUIRED    status=REEVALUATION_REQUIRED  tasks=0
PASS  lost-response-retry  decision=REVIEW_EXTERNAL_EVIDENCE  outcome=EVIDENCE_REVIEW_PENDING  status=COMPLETED              tasks=1
PASS  throttled-then-ok    decision=REVIEW_EXTERNAL_EVIDENCE  outcome=EVIDENCE_REVIEW_PENDING  status=COMPLETED              tasks=1
PASS  readback-mismatch    decision=REVIEW_EXTERNAL_EVIDENCE  outcome=EVIDENCE_REVIEW_PENDING  status=FAILED                 tasks=1
PASS  possible-duplicate-document decision=MANUAL_REVIEW             outcome=MANUAL_REVIEW            status=NO_ACTION              tasks=0
All scenarios matched their expected decision and outcome.

$ EB_CHROMIUM_PATH=/tmp/chromium npx playwright test
Running 27 tests using 1 worker
  ✓   1 e2e/analytics.spec.ts › CH-21: nothing on the gate; nothing before Allow; one load after; only approved event names, no ids
  ✓   2 e2e/analytics.spec.ts › CH-21: No thanks loads nothing; turning analytics off clears Clarity cookies and unloads it
  ✓   3 e2e/evidencebridge.spec.ts › primary success: check → stage → verified task (keyboard-operable)
  ✓   4 e2e/evidencebridge.spec.ts › negative: opt-out stops retrieval and offers no task
  ✓   5 e2e/evidencebridge.spec.ts › negative: read-only viewer cannot run or stage
  ✓   6 e2e/evidencebridge.spec.ts › Excel import changes the next workflow decision
  ✓   7 e2e/evidencebridge.spec.ts › mobile layout has no horizontal page scroll
  ✓   8 e2e/evidencebridge.spec.ts › CH-0A: an opt-out recorded after the check stops staging
  ✓   9 e2e/evidencebridge.spec.ts › CH-0B: scenario time is shown and moving it forward blocks a stale check
  ✓  10 e2e/evidencebridge.spec.ts › CH-5: a staged review shows its due time, and later shows as overdue
  ✓  11 e2e/evidencebridge.spec.ts › CH-6: a second summary for the same period is flagged and nothing can be staged
  ✓  12 e2e/evidencebridge.spec.ts › CH-7: the staging projection is shown with zero write requests
  ✓  13 e2e/evidencebridge.spec.ts › CH-8: the clinic history line is shown and starts empty
  ✓  14 e2e/evidencebridge.spec.ts › CH-10: count bars show billed lines and documented visits with printed numbers
  ✓  15 e2e/evidencebridge.spec.ts › CH-11: earlier checks sit behind a keyboard-operable disclosure
  ✓  16 e2e/evidencebridge.spec.ts › CH-12: source-labelled badges use words, not color alone
  ✓  17 e2e/evidencebridge.spec.ts › CH-13: a blocked viewer can switch demo role inline; the server still decides
  ✓  18 e2e/evidencebridge.spec.ts › CH-14: the stepper shows a stopped outcome in words
  ✓  19 e2e/evidencebridge.spec.ts › CH-15: a search with no match says so and offers to clear it
  ✓  20 e2e/evidencebridge.spec.ts › CH-16: policy details open from the keyboard and state missing provenance
  ✓  21 e2e/evidencebridge.spec.ts › CH-17: the audit chain can be verified from the inspector
  ✓  22 e2e/evidencebridge.spec.ts › CH-19: the evidence check summary is near the decision and shows not-evaluated checks honestly
  ✓  23 e2e/evidencebridge.spec.ts › CH-18: the audit evidence package downloads as JSON with an honest status
  ✓  24 e2e/gate.spec.ts › CH-20: a deep link shows the gate first, which loads nothing from anywhere else
  ✓  25 e2e/gate.spec.ts › CH-20: wrong passcode shows a plain error; right one opens the deep link; lock returns to the gate
  ✓  26 e2e/gate.spec.ts › CH-20: an expired session sends the app back to the gate, keeping the place
  ✓  27 e2e/gate.spec.ts › CH-20: gate layout fits a phone screen and works from the keyboard
  27 passed (18.7s)
```

Local container runs (stand-in base image, see section 10):

```text
## first start: "msg":"Empty database. Loading the primary-success sample scenario once."
## ui document: 200 text/html; charset=utf-8
## deep link: <title>EvidenceBridge · Evidence Review</title>
## check: RUN-69927F42 AWAITING_CONFIRMATION
## stage: COMPLETED task=TASK-EVID-1042 readback=true
## after restart log: "msg":"Existing database. No reseed on restart."
## after restart: tasks=1 draft=EVIDENCE_REVIEW_PENDING run=COMPLETED
## stage again after restart: HTTP 403 {"error":"run RUN-69927F42 is COMPLETED; nothing to stage"}
## tasks after: 1
## audit verify: ehr_audit:OK app_audit:OK
## backup: matches=true integrity=ok tasks=1 chains=OK,OK
## after redeploy: tasks=1 draft=EVIDENCE_REVIEW_PENDING audit: OK,OK
## read-only volume: exit=1 "msg":"Database directory /data is not writable (EACCES). Mount a writable volume there or set EB_DB_PATH. Refusing to start."

## no PIN on 0.0.0.0 refuses to start: exit=1
"msg":"EB_ACCESS_PIN must be exactly 4 digits when the access gate is on."
## EB_ACCESS_GATE=off on 0.0.0.0 refuses too: exit=1
## / without session: 303 -> http://127.0.0.1:18788/gate?next=%2F
## API without session: {"error":"Access session missing or expired. Enter the passcode again.","gate":true} 401
## simulator without session: 401
## asset /assets/index-Jtfpd_Xf.js without session: 401 text/plain; charset=utf-8; with session: 200 text/javascript; charset=utf-8
## wrong PIN: 401 That passcode did not work. Check it and try again.
set-cookie: eb_access=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200; Secure
## primary scenario through the gate: COMPLETED task=TASK-EVID-1042 readback=true
## logout: 303 -> http://127.0.0.1:18788/gate; workspace after: 401
## PIN in logs: 0
## PIN or secret in image files: 0
```

Skipped, with reasons:

- `docker pull node:22.22.0-bookworm-slim`: refused (`Forbidden`) by this environment's network allowlist. The container tests used a stand-in base image instead.
- `npx playwright install chromium`: the browser download is blocked here; a Chromium binary from npm was used.
- Live deploy, DNS, TLS and the Clarity dashboard check: not authorized and no credentials or ids were provided.
- `git push`: not authorized.
