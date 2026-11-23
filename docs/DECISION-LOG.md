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

## Product enhancement decisions (branch `product/ux-enhancement`, 2026-11-22)

Each record: context → decision → consequence. Plan: `docs/PRODUCT-ENHANCEMENT-PLAN.md`.

| ID | Decision | Rationale and consequence |
|---|---|---|
| PD1 | Add a worklist over **existing reads** (`GET /api/worklist`), not a new queue table | Base data already holds 8 drafts with 6 outcomes. Composition keeps the frozen backend frozen; the route is GET-only and a unit test proves it writes nothing |
| PD2 | "Check all waiting drafts" = the existing `/check` per unchecked draft, sequentially, from the browser | Removes a repetitive step (agentic lever V1) without a bulk endpoint. Staging stays per draft and human-confirmed (I-1.1.1); a test proves zero tasks after a bulk check |
| PD3 | Confirmation sheet before staging | The only write deserves an explicit, plain-language consent that restates the staged input. Costs one extra click; Enter-Enter keeps the keyboard path short. Server checks are unchanged and remain authoritative |
| PD4 | Keep the lifecycle stepper (spec CH-1.1 proposed removing it) | V3 CH-14 already maps it from real statuses including stopped/failed/skipped, so the spec's "fake funnel" premise no longer holds; it orients first-time users |
| PD5 | Reject toasts (spec CH-4.3) | Transient messages are easy to miss for older and screen-reader users; persistent `aria-live` result panels stay |
| PD6 | Senior-readable scale instead of a zero-diff token refactor (spec CH-0.3) | The brief's 65+ requirement (≥16 px body, ≥44 px targets) outranks pixel-identity. Visible change by design; contrast for every token pair recorded in the register |
| PD7 | Codes move to Layer 2; a banned-term unit test guards Layer 0/1 | Domain depth without domain vocabulary. Server messages and Technical evidence are not rewritten |
| PD8 | "Why this decision" renders server-derived checks and policy reasons verbatim, never synthesises | Anti-black-box without the risk of invented explanations; a test compares it with all 16 scenarios |
| PD9 | Metrics: server aggregates only; the one estimate lives in the browser with a visible formula and an editable assumption | Invariant I-1.3.4. The estimate is styled and labelled ESTIMATE and is never stored |
| PD10 | Pitch mode is a presentation flag; the tour reads state and never fakes a step | A 3-minute demo that is the real product. `?mode=demo` is the escape hatch |
| PD11 | Print view instead of a PDF library | Spec "zero new heavy dependencies"; the JSON package with digest stays the verifiable export |
| PD12 | Template CSVs pinned as CRLF via `.gitattributes` | The generator writes RFC 4180 CRLF; git normalisation had silently broken one test |
