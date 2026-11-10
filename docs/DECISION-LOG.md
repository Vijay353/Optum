# Decision log

## Implementation decision record

| Item | Decision |
|---|---|
| Product thesis | Provider-side pre-submission evidence reconciliation: surface one external evidence gap as owned, cited review work before anything leaves the provider boundary |
| Primary persona | Provider prior-authorization specialist (secondary: ordering clinician / clinical reviewer) |
| Primary workflow | `PriorAuthDraftCreated` → access gate → claim leads → one HIE document → cited extraction → deterministic decision → human-confirmed Task → readback |
| Minimum success | One `REVIEW_EXTERNAL_EVIDENCE` produces exactly one verified Task and `DRAFT_INCOMPLETE → EVIDENCE_REVIEW_PENDING`, with no chart write and no payer write |
| Integration boundaries | Provider EHR (R + one W), payer Provider Access (R), HIE (R), coverage checklist (R) |
| Deployment | Single local Node process + SQLite; React UI |
| Architecture | Deterministic workflow + rules engine; one bounded extraction component; no agent framework |
| Simulated | All four external systems, the extractor (deterministic default), identity |
| Critical risks | Claims misread as proof; wrong-patient documents; stale context writes; prompt injection; implying proprietary criteria; overstating results |

## Concept correction (ORIGINAL → CHANGE → REASON → CONSEQUENCE)

| # | Original idea (AuthGuard) | Change | Reason | Consequence |
|---|---|---|---|---|
| C1 | AI medical-necessity adjudication | Removed; policy returns only provenance decisions | Licensed clinical judgment; payer function | No "criterion met" anywhere; schema rejects it |
| C2 | InterQual evaluation | Fictional `SYN-SPINE-PA-*` checklist + licensed-criteria adapter seam | Proprietary content | Portable demo, no IP exposure |
| C3 | Physician addendum generation | Removed | Chart writes need clinician authorship | Tool cannot write clinical resources |
| C4 | CPT/NCCI changes | Removed | Coding review is a separate certified function | Out of scope (Example D) |
| C5 | Prior-auth submission, approval prediction, claim protection | Removed | Overlaps Digital Auth Complete; unsafe claims | Slice ends at a review Task |
| C6 | Many workflows | One requirement, one event, one tool | Prove one outcome end to end | Narrow but verifiable |
| C7 | Agent everywhere | Agent only for unstructured extraction | Structured data (EOB, attribution, versions) is deterministic | Smaller attack surface; reproducible |

Context (VERIFIED 2026-10-18 against Optum pages): Digital Auth Complete already checks auth requirements, surfaces payer policy, recommends and bundles documentation, submits and tracks status; InterQual Auth Accelerator indexes documents, highlights evidence, supports configurable automation and states it never auto-denies. EvidenceBridge therefore focuses on **external longitudinal evidence provenance**, not gap-finding or automation in general.

## Decisions and resolved conflicts

| ID | Decision | Rationale |
|---|---|---|
| D1 | Two-phase execution: evaluate on event; execute on the specialist's "Stage" click | Spec §8 runs the tool after the decision; the wireframe and contract §7 put a human confirmation before the mutation. Creating the Task is low impact, but confirmation keeps the provider visibly in control (spec §5.7). Exactly one tool call still occurs per staging |
| D2 | Only the primary transition mutates the draft; other §14 branches are run outcomes | Spec allows one mutating tool; acceptance tests require "no mutation" for the negative paths |
| D3 | Version/policy check precedes the access gate (policy R2a before R1) | Minimum necessary: do not retrieve external data for a stale context. Spec numbering is not a priority order |
| D4 | `ACCESS_NOT_PERMITTED` is a gate result outside the `EvidenceDecision` union | Spec Example E names it; spec §12 union omits it. Kept the union intact |
| D5 | Ambiguous match → `MANUAL_REVIEW`; definite mismatch → `INSUFFICIENT_EVIDENCE` / `MANUAL_REVIEW` state | Reconciles Rule 2 with Example F |
| D6 | Draft `version` = content revision; status change does not bump it | Lets a duplicate event replay idempotently (Example G) while concurrent content edits still conflict (Example H) |
| D7 | Idempotency checked before version | Standard replay semantics; lost-response retry returns the original result |
| D8 | Extraction skipped for patient mismatch or hash mismatch | Do not process another patient's or tampered data |
| D9 | `FixtureEvidenceExtractor` is a deterministic pattern extractor, not hard-coded output | Citations are computed from the real text and work for imported documents; documented as not general NLU |
| D10 | One SQLite file, schema-separated by simulator | Enables atomic cross-simulator imports; documented as a demo convenience |
| D11 | Node built-in `node:sqlite` instead of better-sqlite3 | No native build step; requires Node 22.13+ |
| D12 | Restore = full replace incl. runtime state | Avoids tasks pointing at drafts that no longer exist |
| D13 | Readback includes a payer-write count from the simulator access log | Makes `payerSubmissionPerformed:false` an observed fact in SIMULATED mode, not just a literal |
| D14 | Demo identity switch + static scoped tokens | Exercises authorization paths; explicitly not production auth |
| D15 | Browser E2E with Playwright; in the build sandbox a Chromium binary from npm (`@sparticuz/chromium`) was used via `EB_CHROMIUM_PATH` because the Playwright CDN was blocked | Real browser evidence without changing repo defaults |
| D16 | Penpot SVG assets not produced | The supplied wireframe already covers the design; runnable product prioritised (P2) |
