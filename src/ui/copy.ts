/**
 * Product P4 (spec CH-1.4): the plain-language copy deck for the operator
 * view (Layer 0) and "Why this decision" (Layer 1). One place for wording so
 * it can be read aloud, reviewed and tested. Technical names (rule ids, rule
 * set versions, FHIR resource names, status codes) belong in Layer 2 only;
 * tests/ux.copy.test.ts fails if any appear here.
 */

/** Draft business status in words. Codes stay in Technical evidence. */
export const DRAFT_STATUS_WORDS: Record<string, string> = {
  DRAFT_INCOMPLETE: "Incomplete: a record is missing",
  EVIDENCE_REVIEW_PENDING: "Evidence review pending",
};
export const draftStatusWords = (s: string | null | undefined): string => (s ? DRAFT_STATUS_WORDS[s] ?? "Status not recognised" : "Unknown");

/** What the rules decided, in one sentence a coordinator can act on. */
export const DECISION_WORDS: Record<string, string> = {
  REVIEW_EXTERNAL_EVIDENCE: "Outside evidence was found. A person should review it before submission.",
  CLAIM_LEAD_ONLY: "Only billing records were found. Ask the outside clinic for the therapy notes.",
  ACCESS_NOT_PERMITTED: "Outside records may not be used for this patient. Use your usual records request.",
  SOURCE_UNAVAILABLE: "An outside source did not answer. Nothing was evaluated. Try again later.",
  MANUAL_REVIEW: "A person needs to look at the document. It was not attached automatically.",
  INSUFFICIENT_EVIDENCE: "The evidence cannot be used as found. Nothing was written.",
  NO_DECISION: "The check stopped before a decision.",
};
export const decisionWords = (d: string | null | undefined): string => DECISION_WORDS[d ?? "NO_DECISION"] ?? DECISION_WORDS.NO_DECISION!;

/** Short decision names for counts and charts. */
export const DECISION_SHORT: Record<string, string> = {
  REVIEW_EXTERNAL_EVIDENCE: "Evidence found",
  CLAIM_LEAD_ONLY: "Billing records only",
  ACCESS_NOT_PERMITTED: "Not allowed to look",
  SOURCE_UNAVAILABLE: "Source did not answer",
  MANUAL_REVIEW: "Needs a person",
  INSUFFICIENT_EVIDENCE: "Can't use as found",
  NO_DECISION: "Stopped early",
};

/** Final outcome in words (used where the run ended without a task). */
export const OUTCOME_WORDS: Record<string, string> = {
  EVIDENCE_REVIEW_PENDING: "Evidence review pending",
  CLAIM_SOURCE_FOLLOWUP: "Follow up with the outside clinic",
  SOURCE_UNAVAILABLE: "Outside source unavailable",
  ACCESS_NOT_PERMITTED: "Outside records not permitted",
  MANUAL_REVIEW: "A person must review",
  REEVALUATION_REQUIRED: "Run the check again",
  NO_GAP: "Nothing missing",
};
export const outcomeWords = (o: string | null | undefined): string => (o ? OUTCOME_WORDS[o] ?? "No task for this outcome" : "No task for this outcome");

export const START = {
  lead: "EvidenceBridge looks for the missing physical therapy record in outside sources you are allowed to use.",
  safe: "Checking changes nothing in the chart and sends nothing to the payer.",
  button: "Run evidence check",
  busy: "Checking sources…",
};

export const STAGE = {
  button: "Stage evidence review task",
  retry: "Try staging again",
  busy: "Creating the task and checking it…",
  done: "✓ Review task staged",
  needsRole: "PA specialist confirmation required",
  none: "No task for this outcome",
  doesWhat: "Creates one review task for the PA specialist team. The chart is not changed and nothing is sent to the payer.",
  doneWhat: "The task was read back from the record system and matched.",
  noneWhat: "Only drafts with usable outside evidence get a review task.",
  again: "Run the evidence check again",
};

/** Confirmation sheet shown before the only write (spec CH-1.3). Restates exactly what the code does. */
export const CONFIRM = {
  title: "Create the review task?",
  intro: "Please confirm. This is the only step that changes anything.",
  will: "This will",
  willNot: "This will not",
  willNotItems: ["Change the clinical chart", "Send anything to the payer", "Decide medical necessity or approval"],
  checkedFirst: "Checked again just before writing: permission to use outside records, and how old this check is. If either fails, nothing is written.",
  confirm: "Yes, create the review task",
  cancel: "Cancel",
};

export const BOUNDARY = {
  synthetic: "Synthetic data only",
  noChart: "No chart write",
  noPayer: "No payer submission",
  info: "This is a demonstration with made-up records. It never changes a chart and never contacts a payer.",
};

export const QUEUE = {
  heading: "Drafts to work",
  checkAll: (n: number) => `Check all waiting drafts (${n})`,
  checkAllBusy: (i: number, n: number) => `Checking draft ${i} of ${n}…`,
  checkAllNone: "All drafts checked",
  checkAllHelp: "Runs the same read-only check on each draft. It never creates a task; you stage each one yourself.",
  empty: "No drafts yet. Load a scenario from the Demo Lab.",
  loadError: "The draft list could not be loaded. Nothing was changed. Reload the page to try again.",
};

export const WHY = {
  summary: "Why this decision",
  hint: "Plain-language reasons, taken from the rules that ran. Nothing here is guessed.",
  decided: "What the rules decided",
  roles: "Who does what",
  roleAgent: "Reads one document and quotes facts word for word. It can say \"not sure\". It cannot take actions.",
  roleRules: "Fixed rules decide, the same way every time: permission, document integrity, patient, dates.",
  roleTool: "Creates one review task, only after you confirm. Never writes to the chart, never submits.",
  noRun: "Run the evidence check to see the reasons.",
};

export const STATUS_WORD: Record<"PASS" | "FAIL" | "WARN" | "NOT_EVALUATED", string> = {
  PASS: "Passed",
  FAIL: "Did not pass",
  WARN: "Needs a person",
  NOT_EVALUATED: "Not checked",
};

export const ERRORS = {
  notAffected: "Nothing was written and the chart was not changed.",
  retry: "Try again",
  workspace: "This draft could not be loaded.",
};

export const PACKET = {
  button: "Print evidence summary",
  title: "Evidence summary for review",
  print: "Print or save as PDF",
  close: "Close",
  honesty: "Conceptual prototype with synthetic data. Not an official Optum product. Not a medical-necessity decision.",
};

export const METRICS = {
  heading: "What EvidenceBridge has done here",
  sub: "Counted from the check records on this server. Nothing on this page is made up.",
  empty: "No checks yet. Run a check on the Evidence review tab and the numbers appear here.",
  estimateTitle: "Staff time saved (estimate)",
  estimateLabel: "ESTIMATE",
  minutesLabel: "Minutes a manual records chase takes (your assumption)",
};

/** Every string a test should scan for jargon. */
export const LAYER_01_COPY: unknown[] = [DRAFT_STATUS_WORDS, DECISION_WORDS, DECISION_SHORT, OUTCOME_WORDS, START, STAGE, CONFIRM, BOUNDARY, QUEUE, WHY, STATUS_WORD, ERRORS, PACKET, METRICS];

/** Terms that must not appear on Layer 0/1 (spec CH-1.4). */
export const BANNED_TERMS: RegExp[] = [/EVID-\d/i, /\bR\d_[A-Z]/, /DocumentReference/, /ExplanationOfBenefit/, /\bFHIR\b/, /\bidempoten/i, /DRAFT_INCOMPLETE|EVIDENCE_REVIEW_PENDING|REVIEW_EXTERNAL_EVIDENCE/];
