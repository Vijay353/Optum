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

1. **Data Studio → “sample workbook (.xlsx)”.** Open it in Excel: README sheet, one sheet per entity. On `patient_opt_out`, leave everything as is for now.
2. **Evidence review → scenario “1. Primary success” → Load & reset → Run evidence check.** The EHR simulator emits `PriorAuthDraftCreated`; the orchestrator loads the draft, finds the PT documentation gap, checks Provider Access permission, pulls 12 claim lines (leads only), finds one HIE discharge summary, verifies its SHA-256, matches the patient, extracts five cited facts and returns `REVIEW_EXTERNAL_EVIDENCE`.
3. **View exact cited paragraph** — the highlighted spans are the exact offsets the extractor cited, re-verified against the text.
4. **Stage evidence review task.** One `createEvidenceReviewTask` call writes a FHIR-like Task in the mock EHR; the Task and draft are read back independently (16 checks) and the screen shows `DRAFT_INCOMPLETE → EVIDENCE_REVIEW_PENDING`, Task `TASK-EVID-1042`, duplicate `false`, chart mutation `NONE`, payer submission `NONE`.
5. The scenario bar shows **Scenario time** (fixed at Oct 18, 2026 13:10 UTC for every fixture, so results do not drift with the calendar). **Demo controls → Move scenario time forward 25 hours**, then Stage: the check is now too old and nothing is written.
6. **Demo controls → Redeliver the same event → Stage** → same task, `duplicate: true`. **Simulate another user editing the draft** before staging → the write fails closed with `REEVALUATION_REQUIRED`.
7. **Technical evidence** (collapsed) — the real trace: every HTTP call to every simulator, policy input/output, tool payload/result, readback checks, audit. **Export audit evidence package (JSON)** downloads one file for the run with a named evidence status and a SHA-256 checksum (not a signature); check it with `npx tsx scripts/verifyEvidencePackage.ts <file>`.
8. **Excel → workflow:** set `optedOut` to `TRUE` for `SYN-PAT-1042` in the workbook (or `patient_opt_out.csv`), **Data Studio → Validate & preview → Commit**, then **Run evidence check** again → `ACCESS_NOT_PERMITTED`; no claims or HIE requests are made. **Restore before** in the import history undoes it.
9. Try the other scenarios: claims only, opt-out, ambiguous match, patient mismatch, prompt injection, superseded policy, Provider Access timeout, HIE outage, hash mismatch, concurrent edit, lost response + safe retry, 429 recovery, readback mismatch, and (opt-in, V3) a second summary for the same period.

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
src/ui            React UI: EvidenceBridgePage, TechnicalInspector, CitationViewer, DataStudio
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

Docs: [Architecture](docs/ARCHITECTURE.md) · [Simulator contracts](docs/SIMULATOR-CONTRACTS.md) · [Data import](docs/DATA-IMPORT-GUIDE.md) · [Integrations](docs/INTEGRATIONS.md) · [Traceability](docs/REQUIREMENTS-TRACEABILITY.md) · [Status](docs/IMPLEMENTATION-STATUS.md) · [Test report](docs/TEST-REPORT.md) · [Decisions](docs/DECISION-LOG.md) · [Case study](docs/PORTFOLIO-CASE-STUDY.md) · [Interview guide](docs/INTERVIEW-GUIDE.md)
