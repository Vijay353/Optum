# Interview guide

## 30-second pitch

"EvidenceBridge is a provider-side check that runs before a prior-auth request leaves the building. When the local chart is missing a required document, it uses payer claims only as leads to find the outside clinic, pulls one HIE document, verifies its hash and patient match, extracts cited facts, and — if everything checks out — creates one review task for a PA specialist. It never decides medical necessity, never writes to the chart and never submits to the payer. It's a tested vertical slice with four stateful simulators."

## Likely questions

**Why isn't this an AI agent that decides?**
The decision inputs — attribution, opt-out, versions, hashes, citations — are structured and must be reproducible. The only unstructured step is reading one document, so that's the only model-shaped component, and it can't call tools. Policy EVID-1.0 is a pure function you can unit-test row by row.

**How do you stop prompt injection?**
Three layers: the extractor has no tool access; its output must match a strict schema that rejects keys like `criterionMet`, `approve` or `submission` and verdict language in values; and every quote must exactly equal the source text at the cited offsets. The prompt-injection scenario shows instruction text flagged and ignored; a test with a deliberately compromised model shows the run falling to `MANUAL_REVIEW` with no task.

**What happens if the same event arrives twice?**
The EHR stores the idempotency key durably and checks it before the version check, so the second call returns the original task with `duplicate: true`. The lost-response scenario uses the same mechanism: the EHR commits, the response is dropped, the client retries with the same key.

**And if someone edits the draft in between?**
The tool sends `expectedDraftVersion`. The EHR rejects a mismatch with 409; the orchestrator reloads the draft and ends in `REEVALUATION_REQUIRED`. Nothing is written.

**How do you know the task really exists?**
Read-after-write: the orchestrator fetches the Task and the draft independently and compares 16 fields (owner, focus, evidence hash, extraction hash, policy version, status…) plus the payer simulator's log of write requests. A mismatch marks the run failed — there's a scenario for it — and the UI says the task may exist but is unverified.

**Why are claims "leads, not proof"?**
An ExplanationOfBenefit shows something was billed and adjudicated. It doesn't show completion, response or failure of therapy. The UI says so on every screen with claims, and the claims-only scenario ends in a follow-up, not a task.

**Why a human click before the tool?**
Spec §8 runs the tool after the decision; the wireframe and the provider-trust concern put a person in control. The task is low impact, but the confirmation makes the provider boundary visible. It's logged as `USER_CONFIRMATION`.

**What's real and what's simulated?**
Orchestrator, policy, matching, hashing, citation checks, idempotency, concurrency, readback, import pipeline — real code with tests. EHR, payer, HIE and policy services — behavioral simulators over HTTP. SANDBOX/LIVE adapters and the LLM extractor compile and fail closed. Auth is a demo switch.

**How would this scale to production?**
Swap adapters behind the existing ports; move to independent services with an outbox for events; SMART Backend Services auth; OCR + a validated extraction model; route tasks to the EHR's real work queue; monitoring on abstention and false-match rates.

**What would you measure?**
Only after user testing or production access: time to locate candidate evidence, reviewer acceptance rate of candidates, false-match rate, abstention rate, duplicate-task rate, drafts stopped before incomplete submission, and explanation comprehension. Not approvals or revenue.

**What did you cut and why?**
InterQual logic (proprietary), coding changes (certified review), chart addenda (clinician authorship), PAS submission and approval prediction (out of boundary, overlaps existing products), ROI dashboards (no real data).

## Demo script (3 minutes)

1. Primary success → Run evidence check → walk the three cards.
2. View exact cited paragraph.
3. Stage → result panel: transition, readback 16/16, chart NONE, payer NONE.
4. Technical evidence → trace with real HTTP calls.
5. Load "Concurrent draft edit" → stage → write rejected.
6. Data Studio → upload opt-out change → commit → re-run → access not permitted → restore.
