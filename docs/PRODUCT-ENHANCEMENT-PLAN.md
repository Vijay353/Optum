# EvidenceBridge — Final Draft Plan (product, UX and value enhancement)

Branch `product/ux-enhancement`, base `7d5733e` (2026-11-22). Companion to `EvidenceBridge-Product-Enhancement-Spec.md` (the "spec") and the role/brief prompt (the "brief"). The spec is the non-negotiable baseline; the brief adds the senior-user bar (65+, first use, primary task in 15–20 s) and the business/agentic layer (Section E).

This plan was written **after** a read-only audit and a full baseline run on this checkout. Every "already done" claim below was verified by opening the file or running the gate.

---

## 0. Baseline on this checkout (verified 2026-11-22, Node 22.23.5)

| Gate | Spec expected (2026-10-19) | Actual today |
|---|---|---|
| typecheck | ✓ | ✓ exit 0 |
| lint | ✓ | ✓ exit 0 |
| unit/integration | 91/91 | **268/269** — 1 pre-existing failure (`import.test.ts` › export neutralises formula-like strings) |
| build | ✓ | ✓ 283 kB JS (87 kB gzip) |
| bundle scan | — | ✓ 0 forbidden patterns |
| e2e | 4/5 (mobile flake) | **27/27** (flake not reproducible) |
| demo:cli | 15/15 | **16/16** PASS (15 + opt-in V3 scenario) |

Root cause of the failing test: `scripts/buildTemplates.ts` writes RFC 4180 CSVs with CRLF, but the committed copies in `data/templates/csv/` lost their carriage returns, so the test's CRLF-anchored edit never applied. Fix: commit the regenerated CSVs and a `.gitattributes` rule (`-text`) so git cannot normalise them again. No assertion changes.

**The repository is ahead of the spec.** A V3 wave (CH-0A…CH-22A in `docs/IMPLEMENTATION-STATUS.md`) already shipped: the evidence verification matrix, a JSON audit evidence package with SHA-256 digest, a tamper-evident audit chain, a PIN access gate, a Dockerfile + `DEPLOYMENT.md`, and consent-gated Clarity analytics. Those spec items are re-scoped below rather than rebuilt.

### Spec vs repository conflicts and the safe interpretation taken

| # | Spec says | Repository reality | Interpretation |
|---|---|---|---|
| K1 | 91 tests, 5 e2e | 269 tests, 27 e2e | Gate = "everything that passes today keeps passing" |
| K2 | CH-0.1 fix mobile flake | 27/27 green ×1; flake not reproduced | Add an explicit 15 s expectation timeout (harmless hardening); no app change |
| K3 | CH-0.2 add Node ≥ 22.13 to Quick start | Already in Quick start | No change (DONE upstream) |
| K4 | CH-0.3 tokens with **zero** visual diff | Brief requires ≥16 px body and ≥44 px targets for 65+ users | Tokenise **and** apply the senior-readable scale in one documented CH. A deliberate, visible change, not a regression |
| K5 | Remove the stepper ("fakes a linear funnel") | V3 CH-14 already maps the stepper from real statuses, incl. stopped/failed/skipped; e2e asserts it | Keep it (the premise no longer holds); restyle smaller next to the status |
| K6 | CH-2.2 verification matrix | Done (V3 CH-19) | Reuse inside Layer 0/1; no second implementation |
| K7 | CH-2.3 evidence packet export | JSON package done (V3 CH-18); no human-readable print view | Add a print view built from the same run data |
| K8 | Wave 5 access gate, Docker, analytics | Done (V3 CH-20, CH-22A, CH-21) | No change |
| K9 | V3 CH-9 deferred bulk actions "no queue in UI" | Base data holds **8 drafts with 6 different outcomes** under one scenario (verified via API) | The worklist makes a queue real; bulk *checking* (read-only evaluation) is added; bulk *staging* stays out (I-1.1.1) |
| K10 | Tabs "Worklist / Metrics / Data Studio" | e2e clicks a tab named "Evidence review" | Keep the label "Evidence review" (it names the job); the worklist lives inside it. Add "Metrics" |
| K11 | Push / PR to GitHub | This session has **read-only** access; push was refused | Work is committed locally on `product/ux-enhancement` and handed over as a git bundle + patch series |

---

## Section A — Spec items mapped to files and screens

| Spec CH | What | Files / screen | Plan ID | Status in this plan |
|---|---|---|---|---|
| CH-0.1 | E2E mobile flake | `e2e/evidencebridge.spec.ts` | P1 | Harden (not reproduced) |
| CH-0.2 | README Node version | `README.md` | — | Already done |
| CH-0.3 | Design tokens | `src/ui/styles.css` | P2 | Do (with K4 deviation) |
| CH-1.1 | Three-layer progressive disclosure | `EvidenceBridgePage.tsx`, new `WhyPanel.tsx`, `why.ts` | P4 | Do |
| CH-1.2 | Worklist + `GET /api/worklist` | new `Worklist.tsx`, `worklist.ts`, `src/server/worklist.ts`, `app.ts` | P3 | Do |
| CH-1.3 | One primary action + confirmation sheet | new `ConfirmSheet.tsx`, page, e2e | P5 | Do |
| CH-1.4 | Plain-language copy deck + banned-term test | new `copy.ts`, page, `tests/ux.copy.test.ts` | P4 | Do |
| CH-1.5 | Demo Lab extraction | new `DemoLab.tsx`, `App.tsx`, page | P6 | Do |
| CH-1.6 | Truthful empty / loading / error states | new `states.tsx`, page, worklist, metrics | P4/P3 | Do (skeletons + recovery copy) |
| CH-1.7 | WCAG 2.2 AA | `styles.css`, components, e2e keyboard path | P2/P5 | Do (targets 44 px, above AA's 24 px) |
| CH-2.1 | "Why this decision" panel | `WhyPanel.tsx`, `why.ts` + tests | P4 | Do |
| CH-2.2 | Verification matrix | existing `evidenceChecks` | — | Already done (reused) |
| CH-2.3 | Evidence packet print view | new `EvidencePacket.tsx`, print CSS, e2e | P8 | Do |
| CH-2.4 | Slim safety boundary | `App.tsx`, page | P7 | Do |
| CH-3.1 | Metrics tab, honest KPIs | new `src/server/metrics.ts`, `Metrics.tsx`, `app.ts`, tests | P9 | Do |
| CH-3.2 | Pitch mode + guided tour | `config.ts`, `App.tsx`, new `GuidedTour.tsx`, e2e | P10 | Do |
| CH-3.3 | Investor snapshot strip | `Metrics.tsx` | P9 | Do (copy-summary generator, unit tested) |
| CH-4.1 | Motion pass | `styles.css` | P2 | Do (120–180 ms, reduced-motion zeroes) |
| CH-4.2 | Responsive hardening | `styles.css`, e2e loop over all scenarios at 390 px | P11 | Do |
| CH-4.3 | Toasts | — | — | **Rejected** (see C3) |
| CH-4.4 | Performance budget | `check:bundle`, report | P11 | Do (record numbers) |
| CH-5.x | Access gate, packaging, analytics | — | — | Already done upstream |

## Section B — Additional improvements (beyond the spec)

Each row: problem → change → rationale → files → risk.

**UX flows**

| ID | Problem | Change | Rationale | Files | Risk |
|---|---|---|---|---|---|
| B1 | The app opens on one draft chosen by the demo scenario; a real coordinator works a queue | Worklist rail, default-selects the draft that needs a human first | Job-to-be-done; NN/g #6 recognition over recall | Worklist, page | Low |
| B2 | Every draft must be checked one by one | **"Check all waiting drafts"** — runs the existing read-only check for each unchecked draft, in sequence, then re-sorts the queue | Automation of a repetitive step (Section E, lever V1); never stages | Worklist | Low (no new write path; per-draft `/check` unchanged) |
| B3 | The decision, the next action and the reason are spread over four regions | One "Next step" panel: plain answer, one sentence, one primary button, one line on what the button does | One primary action per screen; Fitts's law (big target near the answer) | page | Medium (layout) |
| B4 | Status codes (`DRAFT_INCOMPLETE → EVIDENCE_REVIEW_PENDING`, `R6`, `EVID-1.1`) on the main surface | Plain-words status map; codes move to Layer 2 | NN/g #2 match the real world; banned-term unit test | `copy.ts` | Low |

**UI / visual**

| ID | Problem | Change | Rationale | Files | Risk |
|---|---|---|---|---|---|
| B5 | 14 px body, 10–12 px labels, 22 px targets | 17 px body, ≥14 px smallest text, ≥44 px targets, 1.5 line height | Senior readability; Apple HIG 44 pt; WCAG 2.5.8 | `styles.css` | Medium (visible change, K4) |
| B6 | Orange accent used for brand, numbers, warnings and primary button alike | Accent reserved for the primary action; status colours only for status; every status also in words | Gestalt similarity; WCAG 1.4.1 | `styles.css` | Low |
| B7 | Loud "SYNTHETIC DATA ONLY" pill + "SAFETY BOUNDARY" badge | One slim boundary line under the top bar | Same truth, less noise (spec CH-2.4) | App | Low |

**Accessibility**

| ID | Change | Rationale |
|---|---|---|
| B8 | Skip link to main content; `aria-live` on the decision region and worklist count | WCAG 2.4.1, 4.1.3 |
| B9 | Confirmation sheet is a native `<dialog>` (focus trap, Escape, focus return) | WCAG 2.1.2, 2.4.3 |
| B10 | Worklist rows are real buttons with `aria-current`, status in text, not colour | WCAG 1.4.1, 4.1.2 |

**Performance / code quality / DX**

| ID | Change | Rationale |
|---|---|---|
| B11 | All new presentation logic in pure, unit-tested modules (`worklist.ts`, `why.ts`, `copy.ts`, `server/metrics.ts`, `pitch.ts`) | Separation of concerns; testable without a DOM (repo has no RTL) |
| B12 | Fix the CRLF template drift with `.gitattributes` | Reproducible builds; the only red test |
| B13 | No new dependencies (verified by `package.json` diff) | Spec I-1.3.1 |

## Section C — Remove or simplify (with justification)

| ID | Item | Decision | Why |
|---|---|---|---|
| C1 | Scenario picker, Load & reset, demo drills in the main flow | **Move** into a dashed "Demo Lab" drawer; hidden in pitch mode | The simulation is a lab instrument, not the product (spec CH-1.5) |
| C2 | "Bounded evidence workflow" BEFORE/AFTER code boxes | **Replace** with a plain-words status pill and the Next-step panel; codes stay in Technical evidence | Duplicate of the stepper and the result panel; jargon on Layer 0 |
| C3 | Toast notifications (spec CH-4.3) | **Reject** | Toasts disappear; older users and screen-reader users miss transient feedback (NN/g on toasts). The existing persistent `aria-live` result panels are kept |
| C4 | Fault-injection UI over `/api/faults` | **Defer** | Every fault already has a one-click scenario in the Demo Lab; a second control surface would duplicate it |
| C5 | Decision chip showing `REVIEW_EXTERNAL_EVIDENCE` | **Move** to Layer 1/2 | Machine label on the primary surface |
| C6 | Agent/Policy/Tool "Decision boundary" aside | **Move** into "Why this decision" | Useful for trust, not for the next action |

No files, dependencies, routes, tests, fixtures or backend behaviour are deleted.

## Section D — Open questions (decisions taken so work is not blocked)

1. **Push access.** This session cannot push to `Vijay353/Optum`. *Taken:* local commits + git bundle + patches; you push or open the PR.
2. **Minutes per manual evidence chase** for the estimate tile. *Taken:* default 35 min (spec), editable, always labelled ESTIMATE with the formula shown. Replace with your own time-study number.
3. **Hallway test (spec §7: 5 users, 60 s).** Not runnable from here. *Taken:* a scripted keyboard/pointer walkthrough timed in e2e; the human test stays an open follow-up.
4. **Pitch-mode identity lock.** *Taken:* pitch mode locks the demo identity to PA specialist; `?mode=demo` restores full chrome for Q&A.

---

## Section E — Business problem deep-dive and value case

### E1. The problem in one sentence

Prior-authorization requests leave the provider incomplete because the evidence the payer will ask for (here: proof of supervised physical therapy) lives outside the provider's chart, so staff discover the gap only after a pend or denial and then chase records by phone and fax.

### E2. MECE issue tree

```
Why do PA requests go out incomplete and cost so much to fix?
├── 1. The evidence is outside the chart (WHERE)
│   ├── 1a Care happened at another org (outside PT clinic)
│   ├── 1b Only billing traces exist locally (claims ≠ clinical proof)
│   └── 1c No standard pull path until Provider Access APIs (CMS-0057-F, Jan 2027)
├── 2. The gap is found too late (WHEN)
│   ├── 2a Checklist compared by memory, not at draft creation
│   └── 2b Discovery happens at payer pend/denial → rework loop
├── 3. Retrieval is manual and unsafe to automate naively (HOW)
│   ├── 3a Consent/attribution must be checked before any pull
│   ├── 3b Patient match and document integrity must be proven
│   └── 3c Extracted facts must cite exact source text (no hallucination)
└── 4. The work is invisible and unowned (WHO)
    ├── 4a No queue of "drafts with an evidence gap"
    ├── 4b No owner/due date for the review
    └── 4c No measurement of time lost, so no budget to fix it
```

Root causes vs symptoms: "staff spend hours on the phone" and "requests are pended" are symptoms. The roots are 1c (no permitted pull path), 2a (no check at draft time) and 3 (no trustworthy way to automate retrieval). The original product addressed 1–3 for **one draft at a time**; it left branch 4 (queue, ownership, measurement) mostly unaddressed in the UI — that is where this engagement adds the most.

### E3. Cost of the status quo (third-party figures, re-verified 2026-11-22)

| Fact | Value | Source |
|---|---|---|
| PA requests per physician per week | 39 | AMA 2024 PA physician survey |
| Physician + staff time on PA per physician per week | 13 h | AMA 2024 survey |
| Physicians saying PA delays care | 93% | AMA 2024 survey (via AJMC, Feb 2025) |
| Physicians reporting a serious adverse event from PA | 29% (2024 survey; 24% in 2023) | AMA surveys |
| Provider time saved per PA moving manual → electronic | 14 min | CAQH Index 2024 |
| Provider cost of a manual PA transaction | ≈ $11 (2023) | CAQH Index via 4sight Health |
| CMS-0057-F Provider Access API compliance | Jan 1, 2027 (operational PA rules Jan 1, 2026) | CMS fact sheet |
| Category proof: Cohere Health | $90M Series C (May 2025), $200M total, 12M+ requests/yr | MedCity News, Becker's |

Corrections to the spec: the AMA serious-adverse-event figure for the 2024 survey is 29%, not "1 in 4" (that was 2023). The spec's Cohere valuation (~$750M), Waystar–Olive $280M and market-size CAGRs were **not** re-verified here and are left out of this document; re-verify before any investor material.

Illustrative order of magnitude (an **estimate**, not an observation): a 20-physician spine/ortho group at 39 PAs/physician/week ≈ 780 PAs/week. If 5% are pended for missing outside documentation and each chase costs 35 staff minutes, that is ≈ 23 staff hours/week (≈ 0.6 FTE) on this one failure mode. Every input is an assumption to replace with the customer's data; the in-app Metrics tab shows the same formula with editable inputs.

### E4. Map of the current solution, honestly

| | Assessment |
|---|---|
| Solves well | Consent-gated retrieval; provenance (hash, patient match, exact citations); one human-confirmed, idempotent, read-back-verified write; fail-closed modes; audit chain |
| Claims but under-delivers | "Turns a gap into owned review work" — true for one draft, but no queue to see or own the work |
| Conflicts with real behaviour | One-draft screen and scenario picker in the main flow make an operator tool read as a demo; codes on the primary surface |
| Missing dimensions | Queue triage (4a), measurement (4c), senior/low-vision usability, plain language, print/hand-off of the proof, a presentation mode that is still the real product |

### E5. Alternative approaches

| | A. Pre-submission evidence layer (recommended) | B. Payer-side completeness check | C. Full submission automation |
|---|---|---|---|
| What | Provider-side check at draft creation; retrieve permitted outside evidence; human confirms | Sell to payers: flag incomplete requests on intake, push requests back | Automate end-to-end submission (Cohere/Waystar territory) |
| Pros | Complements payer UM; clear wedge; regulatory tailwind (Provider Access API); no medical-necessity liability | Payers have budget; fewer integrations | Biggest TAM |
| Cons | Needs EHR + payer API integrations per customer | Doesn't remove provider work; adversarial optics | Crowded; well-funded incumbents; liability |
| Verdict | **Recommended** — the code already implements its hardest controls | Later: "evidence quality network" product | Out of scope (spec §4.2) |

### E6. Agentic AI value layer

Principle: the agent may **find, check, sort, draft and explain**; a person **decides and writes**. No capability below may create a second write path (I-1.1.1).

| Capability | Job-to-be-done | Lever · rough magnitude | Human-in-the-loop boundary | Failure modes → guardrails | Integration (non-conflicting) | State |
|---|---|---|---|---|---|---|
| V1 Queue triage ("Check all waiting drafts") | "Tell me which drafts need me, in order" | Efficiency · removes one click+wait per draft; makes the queue visible | Agent runs read-only checks; never stages | Over-trust of "No action" → each row says why, in words | Calls existing `/check` per draft; no new route | **Built (P3)** |
| V2 Event-driven auto-check on `PriorAuthDraftCreated` | "Check before I even open the draft" | Efficiency · gap found at minute 0 instead of at pend | Same as V1 | Runaway re-checks → idempotent per event id (exists) | Outbox already emits the event; add a subscriber | Roadmap |
| V3 Records-request drafter for `CLAIM_LEAD_ONLY` | "Ask the outside clinic for the PT summary" | Cost · minutes per request; faster turnaround | Agent drafts; person sends | Wrong recipient/PHI leak → recipient from claim lead only, minimum-necessary fields | New tool behind same role/policy guards | Roadmap |
| V4 Validated LLM extractor for real documents | "Read scanned/varied summaries" | Coverage · from synthetic format to real-world docs | Extracted facts must cite exact spans; abstain allowed | Hallucination → existing schema, prohibited-key, verdict-language and exact-citation validators | `LlmEvidenceExtractor` skeleton exists, fail-closed | Skeleton exists (NOT_VERIFIED) |
| V5 Reviewer copilot | "Summarise what this evidence proves vs the checklist" | Retention · faster, more confident reviews | Explanation only; renders policy reasons, never a verdict | Medical-necessity creep → banned verdict language, policy stays deterministic | Builds on "Why this decision" (P4) | Roadmap |
| V6 Measurement agent | "Show my manager what this saves" | Revenue · proof of ROI for renewal | Observed vs estimate always separated | Manufactured ROI → invariant I-1.3.4; formula visible | Metrics tab (P9) | **Built (P9)** |

### E7. Startup-pitch narrative (grounded in the shipped code)

- **Problem.** Physicians and staff spend about 13 hours a week per physician on prior authorization, and requests still go out missing evidence that lives outside the chart.
- **Insight.** Everyone automates the submission. The cheapest place to fix a pend is *before* submission, and from January 2027 payers must expose Provider Access APIs that make permitted retrieval possible.
- **Solution.** EvidenceBridge checks every draft against the documentation checklist, retrieves only permitted outside evidence, proves it (hash, patient match, exact citations) and hands a person one verified review task. Nothing is written to the chart or sent to a payer.
- **Value.** A visible queue, one-click triage, a five-minute human review in place of a phone-and-fax chase, and metrics computed from real runs.
- **Why now.** CMS-0057-F deadlines (2026/2027), AI scepticism among physicians (61% worry AI raises denials, AMA 2024) rewarding *explainable, human-confirmed* automation.
- **Why this team.** The controls investors and compliance buyers ask about — fail-closed modes, idempotency, read-back verification, audit chain — are already running and tested (269 tests, 16 scenarios), not slideware.

Honesty footer: conceptual prototype, synthetic data, simulated integrations, demo identity; not an Optum product.

---

## Implementation order and gates

P0 CSV fix → P1 e2e hardening → P2 tokens + senior scale → P3 worklist + check-all → P4 three layers, copy deck, Why panel, states → P5 confirm sheet → P6 Demo Lab → P7 slim boundary → P8 print packet → P9 metrics + snapshot → P10 pitch mode + tour → P11 responsive + perf. Full gates (typecheck, lint, tests, build, bundle scan, e2e, demo:cli) before each commit; results recorded in `docs/IMPLEMENTATION-STATUS.md` (product register).
