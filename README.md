# Optum EvidenceBridge — Pre-Submission Evidence Review

> **Conceptual portfolio prototype. Not an official Optum product. Synthetic data only.**
> The documentation checklist is fictional and is **not** InterQual, Optum CES or any payer's medical policy.

EvidenceBridge helps a provider prior-authorization specialist find and review external clinical evidence **before** an incomplete prior-authorization request leaves the provider boundary. It implements exactly one vertical slice:

```
PriorAuthDraftCreated → authorized external evidence search → one cited candidate document
→ deterministic REVIEW_EXTERNAL_EVIDENCE → createEvidenceReviewTask (once, human-confirmed)
→ read-back verified DRAFT_INCOMPLETE → EVIDENCE_REVIEW_PENDING
→ no chart write, no payer submission
```

It does **not** decide medical necessity, predict approval, change codes, write to the chart, or submit anything to a payer.

## Quick start

Requirements: Node.js **22.13+** (uses the built-in `node:sqlite`; no native builds, no credentials, no network APIs).

```bash
npm install
npm run dev          # API + simulators on :8787, UI on http://localhost:5173
```

Production-style single process: `npm start` (builds the UI, serves everything on http://127.0.0.1:8787). Container and VPS deployment: `docs/DEPLOYMENT.md`. A hosted copy sits behind a four-digit access gate (`EB_ACCESS_PIN`); it is off on 127.0.0.1, so local use is unchanged. The gate is a convenience for a portfolio demo, separate from the demo role switch, and not real authentication. Optional Microsoft Clarity analytics (`EB_CLARITY_PROJECT_ID`) loads only after entry and only if the visitor chooses Allow.

| Command | What it does |
|---|---|
| `npm run seed -- <scenario>` | Reset the local DB to a scenario (default `primary-success`). Throwaway databases only |
| `npm run bootstrap` | First install: seed only if the database is empty. Safe to rerun |
| `npm run backup -- [dir]` | Consistent SQLite backup, then a restore check of the copy |
| `npm run demo:cli` | Drive all 15 scenarios through real HTTP and print the execution trace |
| `npm run template` | Regenerate the sample workbook, CSVs, invalid examples and `data/templates/SCHEMA.md` |
| `npm run typecheck` / `lint` / `test` / `build` | Quality gates |
| `npm run check` | All gates + client-bundle secret scan |
| `npm run test:e2e` | Browser E2E (run `npx playwright install chromium` once) |

## Three-minute demo

The Evidence review screen is a **queue**: drafts on the left, grouped by what each needs; the selected draft on the right with one next step and one primary button. Scenario loading and failure drills live in the dashed **Demo Lab** strip at the top (hidden in pitch mode).

1. **Check all waiting drafts (8).** Runs the same read-only check on every draft in the base data; nothing is staged. The queue sorts itself: *Needs you* (evidence ready, request records, a person must look, check again), *No action possible* (outside records not allowed).
2. **Draft 99412 → Evidence ready for you.** The EHR simulator emitted `PriorAuthDraftCreated`; EvidenceBridge found the PT documentation gap, checked Provider Access permission, pulled 12 claim lines (leads only), found one HIE discharge summary, verified its SHA-256, matched the patient and extracted five cited facts. **View exact cited paragraph** shows the exact cited offsets.
3. **Stage evidence review task → Yes, create the review task.** The confirmation sheet restates what will and will not happen. One `createEvidenceReviewTask` call writes a FHIR-like Task; it is read back independently (16 checks): draft now *Evidence review pending*, chart changed *No*, sent to payer *No*.
4. **Print evidence summary** (browser print or Save as PDF) and **See why** (plain-language reasons from the rules that ran). Codes, the trace and the JSON audit package with its SHA-256 digest are under **› Technical evidence**.
5. **Metrics** tab: counts computed from the run records, plus one clearly labelled ESTIMATE with its formula and an editable assumption.
6. **Demo Lab → Open the lab:** *Move scenario time forward 25 hours* then Stage → the check is too old and nothing is written. *Redeliver the same event* → same task, no duplicate. *Simulate another user editing the draft* → the write fails closed.
7. **Excel → workflow:** set `optedOut` to `TRUE` for `SYN-PAT-1042` in the sample workbook, **Data Studio → Validate & preview → Commit**, then run the check again → *Outside records not allowed*; no claims or HIE requests are made. **Restore before** in the import history undoes it.
8. Load the other scenarios from the Demo Lab: claims only, opt-out, ambiguous match, patient mismatch, prompt injection, superseded policy, Provider Access timeout, HIE outage, hash mismatch, concurrent edit, lost response + safe retry, 429 recovery, read-back mismatch and (opt-in) a second summary for the same period.

**Pitch mode:** `EB_UI_MODE=pitch` (or `?mode=pitch`) hides the Demo Lab, the Data Studio tab and the identity switch and shows a four-step guided tour that ticks steps from real state. `?mode=demo` restores everything for Q&A.

## Operating modes

| Mode | Status | Behaviour |
|---|---|---|
| `SIMULATED` (default) | Runnable, tested | Four local stateful simulators, deterministic extractor |
| `SANDBOX` | Skeleton, fails closed | Refuses to run until real adapters are implemented and verified; never falls back to simulated data |
| `LIVE` | Skeleton, fails closed | Additionally requires `EB_ALLOW_LIVE=true`; never a default |

`EB_EXTRACTOR=llm` enables the optional `LlmEvidenceExtractor` (NOT_VERIFIED; needs a server-side `ANTHROPIC_API_KEY`). Its output passes the same schema, prohibited-key and exact-citation checks. See `.env.example` and `docs/INTEGRATIONS.md`.

## What is real vs simulated

| Component | Status |
|---|---|
| Orchestrator, policy EVID-1.0, patient matching, hashing, citation checks, idempotency, optimistic concurrency, readback | Real code, tested |
| Mock EHR / FHIR, Provider Access, HIE, policy services | **Simulated** — behavioral simulators over real HTTP with own state, scopes, faults, audit |
| FHIR resource shapes | FHIR-like approximations (Task, ExplanationOfBenefit, DocumentReference); not profile-validated |
| Evidence extractor (default) | Deterministic rules for the synthetic document format — not general NLU |
| LLM extractor, SANDBOX/LIVE adapters, licensed criteria adapter | Placeholders that compile and fail closed |
| Authentication | Demo identity switch and static local tokens — **not** production auth |

## Repository map

```
src/domain        contracts (Zod), policy, state machine, integrity, patient match
src/orchestrator  processPriorAuthDraft (evaluate) + executeStagedTask (tool + readback)
src/agents        EvidenceExtractor, FixtureEvidenceExtractor, LlmEvidenceExtractor
src/tools         createEvidenceReviewTask + readback verification
src/adapters      ports, HTTP client (timeout/retry/jitter), SIMULATED adapters, production skeletons
src/simulators    mock EHR, Provider Access, HIE, policy (Express routers)
src/persistence   SQLite, task/idempotency/audit/run stores
src/data          dataset contract, workbook schema, XLSX/CSV parse/build, import pipeline
src/server        composition root, API, scenarios, config, logger
src/ui            React UI: EvidenceBridgePage (queue + next step), Worklist, WhyPanel, ConfirmSheet,
                  DemoLab, EvidencePacket, Metrics, GuidedTour, TechnicalInspector, CitationViewer,
                  DataStudio; pure presentation modules copy.ts, worklist.ts, why.ts, pitch.ts, metricsText.ts
fixtures/         base synthetic dataset + 15 scenario definitions
data/templates/   sample workbook, CSVs, invalid examples, SCHEMA.md
tests/ e2e/       Vitest (unit/integration/contract) and Playwright
docs/             architecture, contracts, guides, traceability, status, test report, decisions, case study
```

## Troubleshooting

- **`node:sqlite` not found** — upgrade to Node 22.13+.
- **Port 8787 or 5173 busy** — set `EB_PORT` (Vite proxies `/api` to it).
- **Red “Execution is blocked” banner** — `EB_MODE` is not `SIMULATED` or `EB_EXTRACTOR=llm` without a key. This is intentional fail-closed behaviour.
- **Stale local state** — `npm run seed` or “Load & reset” in the UI. The database lives in `data/runtime/` (git-ignored).
- **E2E browser missing** — `npx playwright install chromium`, or set `EB_CHROMIUM_PATH` to an existing Chromium.

Docs: [Product enhancement plan](docs/PRODUCT-ENHANCEMENT-PLAN.md) · [Completion report](docs/PRODUCT-COMPLETION-REPORT.md) · [Architecture](docs/ARCHITECTURE.md) · [Simulator contracts](docs/SIMULATOR-CONTRACTS.md) · [Data import](docs/DATA-IMPORT-GUIDE.md) · [Integrations](docs/INTEGRATIONS.md) · [Traceability](docs/REQUIREMENTS-TRACEABILITY.md) · [Status](docs/IMPLEMENTATION-STATUS.md) · [Test report](docs/TEST-REPORT.md) · [Decisions](docs/DECISION-LOG.md) · [Case study](docs/PORTFOLIO-CASE-STUDY.md) · [Interview guide](docs/INTERVIEW-GUIDE.md)
