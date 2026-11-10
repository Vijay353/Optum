# Requirements traceability

Evidence: **SPEC** = `Optum_EvidenceBridge_Claude_Ready_VSlice.md`; **WF** = corrected wireframe; **MC** = master execution contract. Status: EXECUTED_AND_VERIFIED (automated test passed in this build), IMPLEMENTED, SIMULATED, NOT_IMPLEMENTED.

## Spec §19 acceptance tests

| # | Requirement | Implementation | Test | Status |
|---|---|---|---|---|
| 1 | Primary fixture → `REVIEW_EXTERNAL_EVIDENCE` | `processPriorAuthDraft`, `evidencePolicy` R6 | `vslice.primary.test.ts`, `scenarios.test.ts`, E2E #1 | EXECUTED_AND_VERIFIED |
| 2 | Exactly one tool call | `executeStagedTask`, `execution.toolCalls` | `vslice.primary`, `workflow.reliability` (cannot stage twice) | EXECUTED_AND_VERIFIED |
| 3 | `DRAFT_INCOMPLETE → EVIDENCE_REVIEW_PENDING` | EHR `POST /fhir/Task` transaction | `vslice.primary` (direct DB read) | EXECUTED_AND_VERIFIED |
| 4 | Readback verifies id, owner, focus, hash, policy, status | `verifyTaskReadback` (16 checks) | `vslice.primary`, `readback-mismatch` scenario | EXECUTED_AND_VERIFIED |
| 5 | `chartMutationPerformed` false | Chart fingerprint invariant in EHR tx | `vslice.primary`, `scenarios` (ehr_documents unchanged) | EXECUTED_AND_VERIFIED |
| 6 | `payerSubmissionPerformed` false | No payer write route; payer-write count in readback | `vslice.primary`, `workflow.reliability` (405) | EXECUTED_AND_VERIFIED |
| 7 | Claims-only never says completed/met | UI copy + policy reasons | `scenarios` claims-only, `domain.unit` (reason text scan) | EXECUTED_AND_VERIFIED |
| 8 | Output without citations fails | Strict `EvidenceFactSchema` + `verifyCitations` | `domain.unit`, `llmExtractor` (fabricated quote) | EXECUTED_AND_VERIFIED |
| 9 | Medical-necessity conclusion fails schema | strictObject + prohibited keys + verdict scan | `domain.unit`, `llmExtractor` | EXECUTED_AND_VERIFIED |
| 10 | Ambiguous document → abstain | `FixtureEvidenceExtractor` | `domain.unit`, `ambiguous-match` scenario | EXECUTED_AND_VERIFIED |
| 11 | Policy version mismatch → no mutation | Policy R2a | `policy-superseded` scenario | EXECUTED_AND_VERIFIED |
| 12 | Opt-out prevents retrieval | Access gate + payer-side 403 | `workflow.reliability` (no EOB/HIE log rows), E2E #2 | EXECUTED_AND_VERIFIED |
| 13 | Missing attribution prevents retrieval | Same | `no-attribution` scenario | EXECUTED_AND_VERIFIED |
| 14 | Patient mismatch prevents attachment/task | `computePatientMatch` NONE, extraction skipped | `patient-mismatch` scenario + reliability test | EXECUTED_AND_VERIFIED |
| 15 | Logs contain no body or direct identifier | Redacting logger | `workflow.reliability` (console capture) | EXECUTED_AND_VERIFIED |
| 16 | Prompt injection cannot change policy/tool | Extractor has no tools; schema; flagging | `prompt-injection` scenario, `llmExtractor` compromised model | EXECUTED_AND_VERIFIED |
| 17 | Duplicate event → no duplicate Task | Durable idempotency | `workflow.reliability` Example G | EXECUTED_AND_VERIFIED |
| 18 | Stale draft fails concurrency | `expectedDraftVersion`, 409 | Example H test, `stale-version` scenario | EXECUTED_AND_VERIFIED |
| 19 | Provider Access timeout → `SOURCE_UNAVAILABLE` | HTTP client timeout + policy R0 | `source-unavailable` | EXECUTED_AND_VERIFIED |
| 20 | HIE timeout/outage → visible failure, no mutation | Same | `hie-unavailable` (503) | EXECUTED_AND_VERIFIED |
| 21 | Readback mismatch → failed, no success shown | `READBACK_VERIFICATION` → FAILED | `readback-mismatch` scenario | EXECUTED_AND_VERIFIED |
| 22 | Gap/evidence/limitation/owner/next action visible in 30 s | Three-card layout (WF) | E2E #1 asserts key texts; screenshots | IMPLEMENTED (no timed user study) |
| 23 | Synthetic boundaries visible | Badges, labels, footer | E2E #1 | EXECUTED_AND_VERIFIED |
| 24 | Technical evidence collapsed | `<details>` inspector | E2E #1 (opens it) | EXECUTED_AND_VERIFIED |
| 25–28 | Typecheck, lint, tests, build | `npm run check` | see TEST-REPORT | EXECUTED_AND_VERIFIED |
| 29 | README distinguishes simulated/standards/proprietary/future | README, INTEGRATIONS | review | IMPLEMENTED |

## Spec §23 completion contract

| # | Item | Status |
|---|---|---|
| 1 | Starts from clean install | EXECUTED_AND_VERIFIED (fresh `npm ci` in packaging step — see TEST-REPORT) |
| 2 | Primary fixture loads without credentials | EXECUTED_AND_VERIFIED |
| 3 | Event/decision/tool/state/result chain visible | EXECUTED_AND_VERIFIED (UI + inspector + `demo:cli`) |
| 4 | Durable idempotency | EXECUTED_AND_VERIFIED |
| 5 | Real read-after-write | EXECUTED_AND_VERIFIED |
| 6 | Claims-only and opt-out safe no-action | EXECUTED_AND_VERIFIED |
| 7 | Runtime schema validation of agent output | EXECUTED_AND_VERIFIED |
| 8 | UI reads the same execution state | IMPLEMENTED (UI renders persisted run from `app_runs`; no client state) |
| 9 | Typecheck, lint, tests, build | EXECUTED_AND_VERIFIED |
| 10 | README maps mocks to production adapters | IMPLEMENTED |

## Master contract (selected)

| Requirement | Status |
|---|---|
| G1 slice with negative path | EXECUTED_AND_VERIFIED |
| Stateful simulators with scopes, faults (timeout/429/5xx/403/409), audit, reset | EXECUTED_AND_VERIFIED |
| XLSX template, validated import/preview/commit, export, history, restore | EXECUTED_AND_VERIFIED |
| Formula-injection-safe export | EXECUTED_AND_VERIFIED |
| SIMULATED/SANDBOX/LIVE modes, fail closed | EXECUTED_AND_VERIFIED (SANDBOX → 503) |
| Secrets not in client bundle | EXECUTED_AND_VERIFIED (`check:bundle`) |
| Browser E2E success + negative | EXECUTED_AND_VERIFIED (5 Playwright tests) |
| Penpot SVG assets | NOT_IMPLEMENTED (optional; wireframe supplied) |
