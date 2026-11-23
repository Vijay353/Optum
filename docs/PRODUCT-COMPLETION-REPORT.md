# EvidenceBridge — Product Enhancement Completion Report

Branch `product/ux-enhancement` · base `7d5733e` · plan `docs/PRODUCT-ENHANCEMENT-PLAN.md` · register in `docs/IMPLEMENTATION-STATUS.md` (product section) · decisions PD1–PD12 in `docs/DECISION-LOG.md`.

## 1. Value summary (business terms)

| | Before | After |
|---|---|---|
| **Efficiency** | One draft at a time, chosen by a demo scenario; every check started by hand | A queue of every draft; one click checks all waiting drafts (8 in 0.35 s locally) and sorts them by what each needs. "Next draft that needs you" after each one |
| **Usability** | 14 px text, 22 px targets, status codes (`DRAFT_INCOMPLETE`, `R6`, `EVID-1.1`) on the main screen, demo controls mixed with product | 17 px text, ≥44 px targets, one primary action per draft in plain words, codes only under Technical evidence, demo tools in a labelled lab |
| **Trust** | Correct controls, but explained in engineering terms | A confirmation that restates the only write in words; "Why this decision" from the rules that ran; a printable evidence summary; every metric says how it is counted |
| **Cost / value proof** | No way to show what the product did | Metrics computed from real runs, one labelled estimate with a visible formula and editable assumption, a copyable snapshot |
| **Sales** | Demo needed a narrator who knew the scenarios | Pitch mode with a guided tour that runs on the real API and can't show a success that didn't happen |

Nothing in the authority path changed: same route, same guards, same idempotency, same read-back. `git diff --stat 7d5733e` over orchestrator, domain, simulators, tools, persistence, adapters, agents, data, fixtures and `package*.json` is empty.

## 2. Checklist

**Section A (spec):** CH-0.1 ✓ (P1; not reproduced, hardened) · CH-0.2 ✓ already done · CH-0.3 ✓ (P2, with PD6 deviation) · CH-1.1 ✓ · CH-1.2 ✓ · CH-1.3 ✓ · CH-1.4 ✓ · CH-1.5 ✓ · CH-1.6 ✓ · CH-1.7 ✓ · CH-2.1 ✓ · CH-2.2 ✓ already done (reused) · CH-2.3 ✓ · CH-2.4 ✓ · CH-3.1 ✓ · CH-3.2 ✓ · CH-3.3 ✓ · CH-4.1 ✓ · CH-4.2 ✓ · CH-4.3 ✗ rejected (PD5) · CH-4.4 ✓ · CH-5.1/5.2/5.3 ✓ already done upstream.

**Section B (additional):** B1 worklist ✓ · B2 check all ✓ · B3 next-step panel ✓ · B4 plain status map ✓ · B5 senior scale ✓ · B6 accent discipline ✓ · B7 slim boundary ✓ · B8 skip link + aria-live ✓ · B9 native modal sheet ✓ · B10 worded queue rows with `aria-current` ✓ · B11 pure tested modules ✓ · B12 CRLF fix ✓ · B13 no new dependencies ✓. Also added: "Next draft that needs you", queue fold on narrow screens, decision codes and per-check references in Technical evidence.

**Section C (removed / simplified):** C1 Demo Lab ✓ · C2 BEFORE/AFTER code boxes replaced ✓ · C3 toasts rejected ✓ · C4 fault UI deferred (scenarios cover every fault) · C5 decision chip moved to Layer 2 ✓ · C6 decision-boundary aside moved into "Why this decision" ✓. No file, route, test, fixture or dependency deleted.

## 3. The 65+ first-time user journey

Primary task: *find the draft that needs you and create its review task.*

Path on a fresh page (no triage yet): the most urgent draft is already selected → **Run evidence check** (380×56 px) → read the green headline → **Stage evidence review task** (380×56 px) → confirmation sheet → **Yes, create the review task** (52 px high, focused, so Enter also works). Three presses, no menus, no scrolling at 1280×800 (asserted in e2e P2).

Keystroke-Level Model estimate with older-adult multipliers (1.5× on pointing and mental steps; system time measured):

| Step | Time |
|---|---|
| Find the primary button (M) | 2.0 s |
| Point + click Run (P+B) | 1.9 s |
| System: check | 0.15 s (measured) |
| Read the 6-word headline + glance at the sentence | 4.0 s |
| Point + click Stage | 1.9 s |
| Read the sheet title, decide (M) | 2.0 s |
| Point + click confirm | 1.9 s |
| System: write + read-back | 0.45 s (measured) |
| **Total** | **≈ 14 s** |

Reading every explanatory sentence on the way adds roughly 15–20 s and is optional. This is a model estimate, not a user test: the spec's 5-person hallway test remains open (section 6).

## 4. Accessibility evidence (WCAG 2.2)

| Criterion | Evidence |
|---|---|
| 1.4.3 / 1.4.6 Contrast | Every token pair computed: body text 17.85:1, secondary 10.35:1, muted 6.72–7.56:1, white on accent 5.66:1, status text on its tint 9.07–9.80:1, links 6.23–6.70:1. All ≥ 4.5:1; body and status text ≥ 7:1 (AAA) |
| 1.4.1 Use of colour | Queue rows, checks, badges and decisions always carry words |
| 2.1.1 Keyboard | Full stage path by keyboard (e2e primary: focus Stage, Enter, Enter); disclosures toggle with Enter (CH-11, CH-16) |
| 2.1.2 No trap / 2.4.3 Focus order | Native modal `<dialog>` for the sheet, citation viewer and print view; Escape closes; focus returns |
| 2.4.1 Bypass blocks | Skip link is the first Tab stop and focuses `main` (e2e P2) |
| 2.4.7 Focus visible | 3 px focus ring on every control |
| 2.5.8 Target size | Every visible control ≥ 44 px high (e2e P2 measures all of them; AA needs 24 px) |
| 4.1.3 Status messages | `aria-live` on the next-step panel, result panel and queue count |
| 2.3.3 Motion | 120–180 ms transitions; `prefers-reduced-motion` removes all |
| Reflow | 0 px horizontal overflow at 390 px in all 16 scenarios (e2e P11) |

No automated axe run: adding `@axe-core/playwright` would change `package.json`, and the plan holds dependencies fixed. Recommended as a follow-up devDependency.

## 5. Deviations from the brief and the spec, with reasons

1. **No push or PR.** This session has read-only access to `Vijay353/Optum`; the request for push access was refused. The work is committed locally and delivered as a git bundle and a patch series (section 7).
2. **Token refactor is not zero-diff** (PD6): the senior-readable scale is a deliberate visual change.
3. **Stepper kept** (PD4), **toasts rejected** (PD5), **fault-injection UI deferred** (C4).
4. **Metrics time series omitted**: every scenario runs on one fixed scenario day, so a chart over time would be a single bar. The plan's rule is to show less, not more.
5. **One existing e2e copy assertion changed**: "12 adjudicated PT service lines" → "12 billed PT visit lines" (copy deck). Eight e2e tests gained the confirmation click. No other assertion was edited.
6. **Market figures**: the AMA 2024 serious-adverse-event share is 29% (the spec's "1 in 4" is the 2023 figure). The spec's Cohere valuation, the Waystar–Olive price and the market CAGRs were not re-verified and are not used.

## 6. Follow-ups

- Push the branch and open the PR (commands in section 7).
- Run the 5-person hallway test (spec §7) with at least two participants aged 65+; record results against the ≤ 20 s target.
- Optionally add `@axe-core/playwright` as a devDependency for automated a11y scans.
- Replace the 35-minute default with a customer time study before quoting any estimate.
- Roadmap from Section E: event-driven auto-check (V2), records-request drafter for claim-only drafts (V3), reviewer copilot built on "Why this decision" (V5).
- The pre-existing screenshots in `docs/screenshots/*.png` show the old layout; new ones are in `docs/screenshots/product/`.

## 7. Delivery

```bash
# from a clone of Vijay353/Optum
git fetch /path/to/evidencebridge-product-ux.bundle product/ux-enhancement:product/ux-enhancement
git push -u origin product/ux-enhancement
gh pr create --base main --head product/ux-enhancement --title "Queue-first, plain-language EvidenceBridge (product/UX enhancement)" --body-file docs/PRODUCT-COMPLETION-REPORT.md
# or apply the patch series: git am evidencebridge-patches/*.patch
```

## 8. Verification evidence (final, at the docs commit)

| Gate | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Unit/integration | `npm test` | 306/306, 33 files (base 268/269) |
| Build | `npm run build` | exit 0 · JS 315.5 kB (96.1 kB gzip) · CSS 27.5 kB (6.0 kB gzip) |
| Bundle scan | `npm run check:bundle` | 3 files, 0 forbidden patterns |
| Scenarios | `npm run demo:cli` | 16/16 PASS (decisions and outcomes unchanged) |
| Browser | `EB_CHROMIUM_PATH=/usr/bin/google-chrome npm run test:e2e` ×3 | 34/34, 34/34, 34/34 |
| Frozen paths | `git diff --stat 7d5733e -- src/orchestrator src/domain src/simulators src/tools src/persistence src/adapters src/agents src/data fixtures package.json package-lock.json` | empty |

Screens: `docs/screenshots/product/01-start.png` … `09-pitch-tour.png`.
