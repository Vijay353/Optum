# Integrations — path from simulators to real systems

Status labels: **SIMULATED** (runnable) · **SKELETON** (compiles, fails closed) · **TO_VERIFY** (contract detail not confirmed against a real provider). Nothing here has been tested against a real vendor, payer or HIE. Facts below were checked against official pages on 2026-10-18 where cited.

## Principles

- Ports in `src/adapters/ports.ts` are the contract; domain/policy/tool/UI code does not change when adapters do.
- Mode is selected by `EB_MODE`. SANDBOX/LIVE adapters throw `ProviderNotConfiguredError` and the API returns 503 with the reason. **No silent fallback to simulated data.**
- Secrets live only in the server environment (`.env`, never committed, never in the browser bundle — enforced by `npm run check:bundle`).
- Production would use minimum scopes, separate credentials per system, and keep any payer-submission credential **outside** this application.

## 1. Provider EHR (FHIR) — `EhrPort` → `FhirEhrAdapter` (SKELETON)

| Item | Detail |
|---|---|
| Purpose | Read draft context (ServiceRequest, Coverage, Patient, DocumentReference); write one Task |
| Likely standards | FHIR R4 REST; SMART Backend Services (client-credentials with signed JWT) — **TO_VERIFY per EHR vendor** |
| Prerequisites | EHR sandbox tenant, registered backend app, Task write permission scoped to a work-queue |
| Env | `EB_EHR_FHIR_BASE_URL`, `EB_EHR_CLIENT_ID`, `EB_EHR_CLIENT_SECRET` (or key path) |
| Mapping | Draft → vendor-specific (no standard "prior-auth draft"; may be a Claim draft, Questionnaire session or proprietary object) — **TO_VERIFY** |
| Idempotency | Use conditional create (`If-None-Exist` on a Task identifier = idempotency key) if supported; otherwise a local outbox — **TO_VERIFY** |
| Concurrency | `If-Match` with resource `ETag`/versionId |
| Health check / smoke | `GET [base]/metadata`; create a Task in a sandbox queue, read it back, delete per sandbox policy |
| Known gap | Work-queue routing and Task profiles differ per EHR |

## 2. Payer Provider Access API — `ProviderAccessPort` → `PayerProviderAccessAdapter` (SKELETON)

VERIFIED (CMS, checked 2026-10-18): Provider Access, Payer-to-Payer and Prior Authorization APIs must be in place in **2027**; shorter decision timeframes and specific denial reasons apply in **2026** ([CMS milestones](https://www.cms.gov/priorities/key-initiatives/burden-reduction/interoperability/federal-interoperability)). Payers must share with in-network/enrolled providers that have a treatment relationship, must verify that relationship (method not prescribed), and must let patients opt out, with an opt-out that applies across providers ([CMS Provider Access FAQ](https://www.cms.gov/initiatives/burden-reduction/overview/interoperability/frequently-asked-questions/provider-access-api)).

| Item | Detail |
|---|---|
| Purpose | Attribution/opt-out check, then claims (ExplanationOfBenefit) as **leads only** |
| Likely standards | FHIR R4, payer implementation guides referenced by CMS ([API/IG overview](https://www.cms.gov/initiatives/burden-reduction/overview/interoperability/implementation-guides-standards/application-programming-interfaces-apis-relevant-standards-implementation-guides-igs)) — exact IG versions, bulk vs. per-patient access and attribution endpoints **TO_VERIFY per payer** |
| Env | `EB_PAYER_PROVIDER_ACCESS_BASE_URL`, `EB_PAYER_CLIENT_ID`, `EB_PAYER_CLIENT_SECRET` |
| Contract assumption | An explicit attribution/permission answer exists; in practice it may be implicit (403 on retrieval) — the adapter must then map 403 → `DENY` |
| Rate limits | Payer-defined — honour `Retry-After`; current client retries ≤2 with jitter |
| Smoke | Synthetic member in payer sandbox: permitted patient returns EOBs; opted-out patient is refused |
| Never | Use this adapter for submission. There is intentionally no submission method on the port. |

## 3. HIE / document exchange — `HiePort` → `HieFhirAdapter` (SKELETON)

| Item | Detail |
|---|---|
| Purpose | Locate one external document by patient + author + period; retrieve the payload; verify hash |
| Likely mechanisms | FHIR DocumentReference/Binary or IHE XCA via a trust framework (e.g. Carequality/TEFCA QHIN) — **TO_VERIFY with the HIE** |
| Env | `EB_HIE_BASE_URL`, `EB_HIE_CLIENT_CERT_PATH` (mTLS assumed — TO_VERIFY) |
| Mapping | MPI match confidence may not be exposed; if absent, treat as `probable` (→ AMBIGUOUS) |
| Hash | FHIR `attachment.hash` is base64 SHA-1; compute SHA-256 locally and keep both |
| Smoke | Retrieve a sandbox test document; verify hash; confirm patient search requires demographic correlation |

## 4. Coverage criteria — `PolicyPort` → `LicensedCriteriaPolicyAdapter` (SKELETON)

The prototype uses the fictional `SYN-SPINE-PA-2026-10` checklist. Real criteria (e.g. InterQual) are proprietary and require a license and vendor integration agreement. This repository contains **no** InterQual or Optum CES content and does not imply access to it. A real adapter would return the same `PolicyView` (versioned requirements + lookback) from licensed content or from Da Vinci CRD/DTR responses ([CRD hooks](https://hl7.org/fhir/us/davinci-crd/en/hooks.html), [DTR QuestionnaireResponse](https://hl7.org/fhir/us/davinci-dtr/STU2/StructureDefinition-dtr-questionnaireresponse.html)) — **TO_VERIFY**.

## 5. Model provider — `EvidenceExtractor` → `LlmEvidenceExtractor` (NOT_VERIFIED, disabled)

| Item | Detail |
|---|---|
| Enable | `EB_EXTRACTOR=llm`, server-side `ANTHROPIC_API_KEY`, optional `EB_LLM_MODEL` |
| Call | Anthropic Messages API (`POST /v1/messages`) — confirm current headers/models at https://docs.claude.com before enabling |
| Guarantees kept | No tools exposed to the model; document wrapped as data; output passes strict schema, prohibited-key scan, verdict-language scan and exact-citation verification; failures → `MANUAL_REVIEW` (tested with a stub client in `tests/llmExtractor.test.ts`) |
| Before production | BAA / data-processing terms for any PHI; prompt-injection evaluation set; latency/cost budget; abstention-rate monitoring |

## 6. Prior-authorization submission — out of scope

Da Vinci PAS `Claim/$submit` ([spec](https://hl7.org/fhir/us/davinci-pas/en/OperationDefinition-Claim-submit.html)) is deliberately **not** implemented. EvidenceBridge ends at an owned, cited review task inside the provider boundary.

## Rollback

Set `EB_MODE=SIMULATED`. Adapters are stateless; the only write (Task) is idempotent and auditable in the EHR.
