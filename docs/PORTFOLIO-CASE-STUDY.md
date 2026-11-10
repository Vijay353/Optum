# Case study — EvidenceBridge: pre-submission evidence review

*Conceptual extension of Optum Insight's provider prior-authorization tooling. Not an official Optum product. Synthetic data only. No performance claims.*

## The problem

Before a prior-authorization request goes to a payer, a provider PA specialist assembles documentation from the local EHR. For an elective spine procedure, a required item — documented supervised physical therapy — often happened at an outside clinic. Payer claims can show that PT was *billed*; an HIE may hold the actual discharge summary. Finding, matching and attaching that record is manual, and the request can go out incomplete even though the evidence exists.

## What I changed about the original idea

The starting concept ("AuthGuard") combined coverage discovery, InterQual evaluation, claims retrieval, HIE retrieval, contraindication inference, CPT/NCCI changes, physician addenda, submission, adjudication and claim protection. I narrowed it because:

- Optum Digital Auth Complete already checks auth requirements, surfaces payer policy, recommends and bundles documentation, submits and tracks status; InterQual Auth Accelerator already indexes documents and highlights evidence on the payer side (verified on Optum's pages).
- Medical necessity, chart addenda and coding are licensed or certified human functions.
- InterQual criteria are proprietary.
- Provider Access APIs are a 2027 requirement under CMS-0057-F — a *future* dependency in October 2026.

The defensible gap is **external evidence provenance**: when the local chart is missing something, find candidate external evidence, say exactly what it does and does not prove, and turn it into owned review work — without touching the chart or the payer.

## What I built

A runnable, tested vertical slice (TypeScript, React, Node, SQLite):

- **Four stateful simulators** reached over real HTTP — provider EHR/FHIR, a mock CMS-0057-F Provider Access server, an HIE and a synthetic policy service — each with its own tables, scoped demo credentials, fault injection (timeouts, 429, 5xx, concurrent edits, lost responses, tampered payloads) and audit.
- **A deterministic orchestrator**: event → version check → consent/attribution gate → claims as leads → one HIE document → SHA-256 → patient correlation → bounded extraction → policy EVID-1.0 → human-confirmed tool → read-after-write.
- **One bounded "agent" component**: extraction from one unstructured document, returning facts with exact character offsets or abstaining. It has no tools. Its output is validated with a strict schema that rejects `criterionMet`, approval, codes and attestation text, and every quote is re-checked against the source.
- **One mutating tool**, `createEvidenceReviewTask`, with role and policy gates, durable idempotency, optimistic concurrency and an atomic Task + status write; the orchestrator then reads both back and compares 16 fields plus the payer's write log.
- **A business UI** built from the provided wireframe: what is missing, what was found, what happens next, a visible "NO PAYER SUBMISSION" boundary, a citation viewer and a collapsed technical inspector showing the real trace.
- **Data Studio**: an Excel workbook that populates all simulators through preview → confirm → atomic commit → verification, with history, restore and formula-safe export.
- 15 deterministic scenarios covering the happy path and every failure mode in the spec.

## Evidence

91 automated tests (unit, contract, integration over HTTP), 5 browser E2E tests, a CLI demo that runs all 15 scenarios, a clean-install verification, and screenshots. See `TEST-REPORT.md`. I report no approval, denial, revenue or turnaround improvements — none can be measured with synthetic data.

## Alternatives considered

| Option | Why not |
|---|---|
| LLM agent orchestrating retrieval and deciding | Structured data (EOB, attribution, versions) is better handled deterministically; an LLM verdict would be unsafe and unreproducible |
| Pure CRUD checklist | Doesn't address the external-evidence problem |
| RAG over a document store | One document per case; retrieval is a deterministic record locator, not semantic search |
| Auto-attach evidence to the packet | Clinical-content decisions stay with a human reviewer |

## Limitations

Simulated systems, approximate FHIR shapes, demo authentication, a rules-based extractor that only understands the synthetic format, single-process deployment, and no user research yet. The spec's discovery plan (11 participants, 10 reconstructed cases, failure drills) is the next step before any further build.

## What I would do next

1. Run the discovery plan; measure how often missing external documents cause pends.
2. Replace the extractor with a validated model + OCR, with an evaluation set and abstention monitoring.
3. Implement one real adapter (a payer Provider Access sandbox) behind the existing port.
4. Add the reviewer's next actions on the Task (accept evidence into packet, request records) as a second slice.
