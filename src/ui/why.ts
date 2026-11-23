/**
 * Product P4 (spec CH-2.1): "Why this decision", as ordered plain questions.
 * Pure. Built only from the server-derived evidence checks (which already say
 * "not evaluated" for checks that did not run) and the policy's own reasons.
 * A question whose check is absent from the input is absent from the output.
 * Technical references (record ids, hashes, rule ids) are never copied in.
 */
import type { EvidenceCheck } from "../orchestrator/evidenceChecks";
import type { Run } from "../orchestrator/runTypes";
import { decisionWords } from "./copy";

export type WhyBlock = { id: string; question: string; status: EvidenceCheck["status"]; answer: string };
export type WhyView = { decision: string; reasons: string[]; blocks: WhyBlock[] };

/** Reading order and the question each check answers. */
const QUESTIONS: Array<[string, string]> = [
  ["LOCAL_CHART", "Did we check your chart first?"],
  ["PROVIDER_ACCESS", "Were we allowed to look at outside records?"],
  ["SOURCES_AVAILABLE", "Did the outside sources answer?"],
  ["CLAIM_LEADS", "Did insurance claims point to an outside clinic?"],
  ["CLINICAL_DOCUMENT", "Was a clinical document found?"],
  ["SINGLE_CANDIDATE", "Was there only one document to choose from?"],
  ["DOCUMENT_HASH", "Is the document unchanged since it was shared?"],
  ["PATIENT_MATCH", "Is it the same patient?"],
  ["CITATIONS", "Does every fact quote the document word for word?"],
  ["LOOKBACK", "Is the therapy recent enough for the checklist?"],
  ["PRE_WRITE_RECHECK", "Was permission checked again just before writing?"],
  ["READBACK", "Did the saved task match what was asked for?"],
];

export function whyView(run: Run | null, checks: EvidenceCheck[]): WhyView | null {
  if (!run) return null;
  const byId = new Map(checks.map((c) => [c.checkId, c]));
  const blocks: WhyBlock[] = [];
  for (const [id, question] of QUESTIONS) {
    const c = byId.get(id);
    if (!c) continue;
    blocks.push({ id, question, status: c.status, answer: c.detail });
  }
  const reasons = run.policyResult?.reasons ?? (run.error ? [run.error] : []);
  return { decision: decisionWords(run.policyResult?.decision ?? null), reasons, blocks };
}
