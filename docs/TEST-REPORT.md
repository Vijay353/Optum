# Test report

All results below come from actual runs on 2026-10-18 (Node v22.22.0, Linux), in the working tree **and** in a clean copy installed with `npm ci`.

## Commands and results

| Command | Result |
|---|---|
| `npm run typecheck` | pass (tsc strict, `noUncheckedIndexedAccess`) |
| `npm run lint` | pass (0 problems) |
| `npm test` | **7 files, 91 tests passed, 0 failed** (~13 s) |
| `npm run build` | pass (Vite 8; JS 260 kB / 80 kB gzip) |
| `npm run check:bundle` | pass — 3 files scanned, 0 forbidden patterns |
| `npm run demo:cli` | 15/15 scenarios matched expected decision and outcome |
| `npm run test:e2e` | **5 Playwright tests passed** (Chromium, desktop + 390 px mobile) |

E2E note: the Playwright browser CDN is blocked in the build sandbox, so E2E ran with `EB_CHROMIUM_PATH` pointing to a Chromium binary installed from npm (`@sparticuz/chromium`, not a project dependency). On a normal machine run `npx playwright install chromium` first.

## Suites

| File | Tests | Covers |
|---|---|---|
| `tests/vslice.primary.test.ts` | 2 | G1 slice end to end over HTTP; viewer cannot stage |
| `tests/scenarios.test.ts` | 15 | Every scenario fixture: decision, outcome, task count, draft status, zero payer writes, chart unchanged |
| `tests/workflow.reliability.test.ts` | 17 | Duplicate event, concurrent edit, stale event, lost response + retry, 429 recovery, timeout, retryable EHR failure, double staging; opt-out (no retrieval + payer-side 403), no submission route, no Draft.write scope, patient mismatch, log redaction; prompt injection; SANDBOX and LLM-without-key fail closed |
| `tests/domain.unit.test.ts` | 32 | Policy EVID-1.0 (14 rule cases, determinism, no verdict language), agent output validation (prohibited keys, verdicts, missing citations), citation offsets, hashing, extractor, patient match, state machine |
| `tests/llmExtractor.test.ts` | 3 | Optional LLM adapter fails closed; compromised model output rejected; fabricated quote rejected |
| `tests/import.test.ts` | 19 | Idempotent re-import, edited workbook changes the next decision, restore, stale preview, version-less change, replace mode, viewer refused, 8 invalid workbooks, oversized/xlsm/unreadable files, identifier-like column, CSV import, formula-injection-safe export |
| `tests/security.test.ts` | 3 | No real-looking keys in source, dummy-only `.env.example`, UI never imports server modules |
| `e2e/evidencebridge.spec.ts` | 5 | Success path (keyboard Enter on the stage button, citation dialog, inspector), opt-out negative, viewer negative, Excel import → changed decision, mobile no horizontal scroll |

## Known omissions

- No timed usability study for the 30-second comprehension goal (spec test 22): layout and copy follow the wireframe; screenshots in `docs/screenshots/`.
- No automated colour-contrast audit tool was run; colours were chosen for WCAG AA on white, and keyboard focus is visible (`:focus-visible`).
- SANDBOX/LIVE adapters and the LLM extractor were not exercised against real services (NOT_VERIFIED).
- `npm audit --omit=dev` reports 2 moderate advisories in `uuid` (transitive via exceljs; affects v3/v5/v6 with a caller-supplied buffer, which this app does not use). Not fixed: the suggested fix is a breaking exceljs change.
- Load/performance testing was not performed.

## V3 (controlled enhancement), 2026-11-09

Final run on branch `enhance/evidencebridge-v3`, Node v22.22.0, Linux. Full detail and verbatim output: `docs/V3-CHANGE-REPORT.md`.

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass (0 problems) |
| `npm test` | **29 files, 266 tests passed, 0 failed** |
| `npm run build` | pass (JS 282.88 kB / 86.95 kB gzip) |
| `npm run check:bundle` | pass, 3 files scanned, 0 forbidden patterns |
| `npm run demo:cli` | 16/16 scenarios matched (15 base unchanged + 1 opt-in) |
| `npx playwright test` | **27 passed** (two servers: gate off on :8799, gate on with a stubbed analytics endpoint on :8798) |

New suites: `ch0a` 7, `ch0b` 10, `ch1` 9, `ch2` 13, `ch5` 3, `ch6` 10, `ch7` 4, `ch8` 3, `ch10` 5, `ch11` 2, `ch12` 5, `ch13` 3, `ch14` 21, `ch15` 4, `ch16` 3, `ch17` 8, `ch18` 8, `ch19` 21, `ch20` 12, `ch21` 9, `ch22` 8, `v3.invariants` 6. New browser specs: `e2e/gate.spec.ts` 4, `e2e/analytics.spec.ts` 2, plus 16 V3 cases in `e2e/evidencebridge.spec.ts`.

Repeatability: after a test-isolation fix found during packaging, six consecutive full browser runs in a clean unzipped copy, with state kept between runs, passed 27/27 each.

Container checks (CH-22A and CH-20) ran in a local Docker daemon on a stand-in Node 22.22.0 base image because Docker Hub is blocked in this environment. See the change report, section 10.
