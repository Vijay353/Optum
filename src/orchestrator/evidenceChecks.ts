/**
 * Evidence verification matrix (V3 CH-19).
 *
 * Derived on the server from the persisted run record: the values the policy
 * actually received (run.policyInput), the evidence stored with the run, and
 * the trace. It does not re-run the policy and computes nothing new.
 * A check that never ran is NOT_EVALUATED, never PASS.
 * WARN = a person must look; FAIL = the check did not pass.
 * blocksAutoAction = a WARN or FAIL here stops the review task from being created.
 */
import type { Run } from "./runTypes";

export type CheckStatus = "PASS" | "FAIL" | "WARN" | "NOT_EVALUATED";
export type EvidenceCheck = {
  checkId: string;
  label: string;
  status: CheckStatus;
  evidenceRefs: string[];
  detail: string;
  evaluatedAt?: string;
  ruleVersion?: string;
  blocksAutoAction: boolean;
};

const at = (run: Run, step: string) => run.trace.find((t) => t.step === step)?.at;

export function evidenceChecks(run: Run): EvidenceCheck[] {
  const pi = run.policyInput;
  const rv = run.policyResult?.policyVersion;
  const decidedAt = at(run, "POLICY_DECISION");
  const out: EvidenceCheck[] = [];
  const add = (c: EvidenceCheck) => out.push(c.evaluatedAt === undefined ? (({ evaluatedAt: _a, ...rest }) => rest)(c) : c);
  const ne = (checkId: string, label: string, detail: string, blocksAutoAction = true): EvidenceCheck =>
    ({ checkId, label, status: "NOT_EVALUATED", evidenceRefs: [], detail, blocksAutoAction });

  // Local chart
  const req = run.context?.missingRequirement;
  add(req
    ? { checkId: "LOCAL_CHART", label: "Local chart checked for the requirement", status: "PASS", evidenceRefs: (run.context?.localDocuments ?? []).map((d) => `DocumentReference/${d.id}`), detail: req.localStatus === "MISSING" ? "Missing locally, so outside evidence was searched." : "Present locally, so no outside search was needed.", evaluatedAt: at(run, "GAP_CHECK"), blocksAutoAction: false }
    : ne("LOCAL_CHART", "Local chart checked for the requirement", "The check stopped before the local chart was read.", false));

  // Versions (policy inputs; only meaningful once the policy ran)
  if (pi && run.context) {
    add({ checkId: "DRAFT_VERSION", label: "Draft version matches the event", status: pi.draftVersionMatches ? "PASS" : "FAIL", evidenceRefs: [`Draft/${run.event.draftId}|v${run.event.draftVersion}`, `current v${run.context.draft.version}`], detail: pi.draftVersionMatches ? "The draft has not changed since the event." : "The draft changed after the event.", evaluatedAt: decidedAt, ruleVersion: rv, blocksAutoAction: true });
    add({ checkId: "POLICY_VERSION", label: "Coverage policy version is current", status: pi.policyVersionMatches ? "PASS" : "FAIL", evidenceRefs: [`Policy/${run.context.policy.policyVersion}`], detail: pi.policyVersionMatches ? "The draft's policy version is active." : `The draft cites ${run.context.policy.status} policy ${run.context.policy.policyVersion}.`, evaluatedAt: decidedAt, ruleVersion: rv, blocksAutoAction: true });
  } else {
    add(ne("DRAFT_VERSION", "Draft version matches the event", "No policy decision was recorded."));
    add(ne("POLICY_VERSION", "Coverage policy version is current", "No policy decision was recorded."));
  }

  // External sources responded
  const down = run.trace.find((t) => t.step === "SOURCE_UNAVAILABLE");
  const externalCalls = run.trace.flatMap((t) => t.calls).filter((c) => c.system === "mock-provider-access" || c.system === "mock-hie").length;
  add(down
    ? { checkId: "SOURCES_AVAILABLE", label: "Outside sources responded", status: "FAIL", evidenceRefs: [], detail: down.summary, evaluatedAt: down.at, blocksAutoAction: true }
    : externalCalls > 0
      ? { checkId: "SOURCES_AVAILABLE", label: "Outside sources responded", status: "PASS", evidenceRefs: [], detail: `${externalCalls} request(s) to the payer and HIE answered.`, blocksAutoAction: true }
      : ne("SOURCES_AVAILABLE", "Outside sources responded", "No outside source was called."));

  // Provider Access
  add(run.access
    ? { checkId: "PROVIDER_ACCESS", label: "Provider Access permitted (attribution and opt-out)", status: run.access.decision === "PERMIT" ? "PASS" : "FAIL", evidenceRefs: [`ProviderAccess/${run.access.patientId}|${run.access.providerOrgId}`], detail: run.access.decision === "PERMIT" ? "Attributed, established relationship, not opted out." : run.access.reasons.join(" "), evaluatedAt: at(run, "PROVIDER_ACCESS_AUTHORIZATION"), ruleVersion: rv, blocksAutoAction: true }
    : ne("PROVIDER_ACCESS", "Provider Access permitted (attribution and opt-out)", "Not checked: the check stopped earlier."));

  // Claim leads
  add(run.claims
    ? { checkId: "CLAIM_LEADS", label: "Claim leads point to an outside source", status: run.claims.leadCount > 0 ? "PASS" : "FAIL", evidenceRefs: [...new Set(run.claims.leads.map((l) => `ExplanationOfBenefit/${l.id}`))], detail: run.claims.leadCount > 0 ? `${run.claims.leadCount} lines from ${run.claims.providerName}. Leads only, not proof.` : "No claim lines in the lookback window.", evaluatedAt: at(run, "CLAIM_LEADS"), ruleVersion: rv, blocksAutoAction: true }
    : ne("CLAIM_LEADS", "Claim leads point to an outside source", "Not requested."));

  // Clinical document found, and only one
  const searched = run.claims && run.claims.leadCount > 0 && !down;
  add(run.document
    ? { checkId: "CLINICAL_DOCUMENT", label: "Clinical document found", status: "PASS", evidenceRefs: [`DocumentReference/${run.document.id}`], detail: `${run.document.title}, dated ${run.document.date}.`, evaluatedAt: at(run, "HIE_DOCUMENT_SEARCH"), ruleVersion: rv, blocksAutoAction: true }
    : searched && run.trace.some((t) => t.step === "HIE_DOCUMENT_SEARCH" && t.ok)
      ? { checkId: "CLINICAL_DOCUMENT", label: "Clinical document found", status: "FAIL", evidenceRefs: [], detail: "No document from the lead clinic for these dates. Claims alone are not proof.", evaluatedAt: at(run, "HIE_DOCUMENT_SEARCH"), ruleVersion: rv, blocksAutoAction: true }
      : ne("CLINICAL_DOCUMENT", "Clinical document found", "No document search was made."));
  add(run.candidates
    ? { checkId: "SINGLE_CANDIDATE", label: "Only one candidate document for the period", status: run.candidates.length <= 1 ? "PASS" : "WARN", evidenceRefs: run.candidates.map((c) => `DocumentReference/${c.id}`), detail: run.candidates.length <= 1 ? "One candidate." : `${run.candidates.length} candidates from the same clinic and period. A person must choose.`, evaluatedAt: at(run, "HIE_DOCUMENT_SEARCH"), ruleVersion: rv, blocksAutoAction: true }
    : ne("SINGLE_CANDIDATE", "Only one candidate document for the period", "No document search was made."));

  // Document integrity and patient
  add(run.document
    ? { checkId: "DOCUMENT_HASH", label: "Document hash matches", status: run.document.hashVerified ? "PASS" : "FAIL", evidenceRefs: [`sha256:${run.document.computedSha256}`], detail: run.document.hashVerified ? "Payload matches the hash the HIE published." : "Payload differs from the published hash.", evaluatedAt: at(run, "DOCUMENT_HASH"), ruleVersion: rv, blocksAutoAction: true }
    : ne("DOCUMENT_HASH", "Document hash matches", "No document was retrieved."));
  add(run.patientMatch
    ? { checkId: "PATIENT_MATCH", label: "Document belongs to this patient", status: run.patientMatch.match === "EXACT" ? "PASS" : run.patientMatch.match === "AMBIGUOUS" ? "WARN" : "FAIL", evidenceRefs: [`Patient/${run.event.patientId}`], detail: run.patientMatch.reasons.join(" "), evaluatedAt: at(run, "PATIENT_MATCH"), ruleVersion: rv, blocksAutoAction: true }
    : ne("PATIENT_MATCH", "Document belongs to this patient", "No document was retrieved."));

  // Extraction
  const ex = run.extraction;
  add(!ex || ex.skippedReason
    ? ne("EXTRACTION_OUTPUT", "Extractor output is valid and bounded", ex?.skippedReason ? `Not run: ${ex.skippedReason}.` : "No document was read.")
    : ex.validationIssues.length
      ? { checkId: "EXTRACTION_OUTPUT", label: "Extractor output is valid and bounded", status: "FAIL", evidenceRefs: [], detail: ex.validationIssues.join("; "), evaluatedAt: at(run, "EXTRACTION_VALIDATION"), ruleVersion: rv, blocksAutoAction: true }
      : { checkId: "EXTRACTION_OUTPUT", label: "Extractor output is valid and bounded", status: ex.output?.abstain ? "WARN" : "PASS", evidenceRefs: ex.extractionHash ? [`sha256:${ex.extractionHash}`] : [], detail: ex.output?.abstain ? `The extractor abstained: ${ex.output.ambiguity.join(" ")}` : `Schema valid, ${ex.output?.facts.length ?? 0} facts, no verdict language.`, evaluatedAt: at(run, "EXTRACTION_VALIDATION"), ruleVersion: rv, blocksAutoAction: true });
  const facts = ex?.output?.facts ?? [];
  add(ex && !ex.skippedReason && ex.citationChecks.length > 0
    ? { checkId: "CITATIONS", label: "Every fact quotes the source exactly", status: ex.citationChecks.every((c) => c.valid) ? "PASS" : "FAIL", evidenceRefs: facts.map((f) => `p${f.sourcePage}:${f.sourceStart}-${f.sourceEnd}`), detail: ex.citationChecks.every((c) => c.valid) ? `${ex.citationChecks.length} quotes match their offsets.` : ex.citationChecks.filter((c) => !c.valid).map((c) => `${c.field}: ${c.reason}`).join("; "), evaluatedAt: at(run, "EXTRACTION_VALIDATION"), ruleVersion: rv, blocksAutoAction: true }
    : ne("CITATIONS", "Every fact quotes the source exactly", "No facts were extracted."));
  add(run.lookback
    ? { checkId: "LOOKBACK", label: "Evidence is inside the lookback window", status: run.lookback.within ? "PASS" : "FAIL", evidenceRefs: [`window from ${run.lookback.windowStart}`], detail: `Evidence date ${run.lookback.evidenceDate ?? "unknown"}.`, evaluatedAt: decidedAt, ruleVersion: rv, blocksAutoAction: true }
    : ne("LOOKBACK", "Evidence is inside the lookback window", "No evidence date to compare."));

  // Write path (CH-0A re-check, EHR write, read-back)
  const pre = run.execution.preWriteCheck;
  add(pre
    ? { checkId: "PRE_WRITE_RECHECK", label: "Access and age checked again before writing", status: pre.passed ? "PASS" : "FAIL", evidenceRefs: [], detail: pre.passed ? `Still permitted; check is ${pre.runAgeMinutes} of ${pre.maxAgeMinutes} minutes old.` : `Refused: ${pre.refusal}.`, evaluatedAt: pre.at, blocksAutoAction: true }
    : ne("PRE_WRITE_RECHECK", "Access and age checked again before writing", "Not staged."));
  const err = run.execution.error;
  add(run.execution.result
    ? { checkId: "TASK_WRITE", label: "EHR accepted the task write", status: "PASS", evidenceRefs: [`Task/${run.execution.result.taskId}`], detail: run.execution.result.duplicate ? "Returned the task created earlier (same idempotency key)." : "One task created with the draft status change.", evaluatedAt: at(run, "TOOL_CALL createEvidenceReviewTask"), blocksAutoAction: true }
    : pre?.passed && err
      ? { checkId: "TASK_WRITE", label: "EHR accepted the task write", status: "FAIL", evidenceRefs: [], detail: err.message, evaluatedAt: at(run, "TOOL_CALL createEvidenceReviewTask"), blocksAutoAction: true }
      : ne("TASK_WRITE", "EHR accepted the task write", "No write was attempted."));
  const rb = run.execution.readback;
  add(rb && rb.checks.length
    ? { checkId: "READBACK", label: "Task and draft read back and match", status: rb.verified ? "PASS" : "FAIL", evidenceRefs: rb.task ? [`Task/${rb.task.id}`] : [], detail: rb.verified ? `${rb.checks.length} of ${rb.checks.length} fields match.` : `Mismatch: ${rb.checks.filter((c) => !c.pass).map((c) => c.name).join(", ")}.`, evaluatedAt: at(run, "READBACK_VERIFICATION"), blocksAutoAction: false }
    : ne("READBACK", "Task and draft read back and match", "Nothing was read back.", false));
  return out;
}

export function summarizeChecks(checks: EvidenceCheck[]) {
  return {
    passed: checks.filter((c) => c.status === "PASS").length,
    warned: checks.filter((c) => c.status === "WARN").length,
    blocked: checks.filter((c) => c.status === "FAIL").length,
    notEvaluated: checks.filter((c) => c.status === "NOT_EVALUATED").length,
  };
}
