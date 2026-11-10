/**
 * Optional analytics (V3 CH-21). Microsoft Clarity, loaded only:
 *   - after verified access (the server sends settings only when the CH-20 gate is on and passed),
 *   - after the visitor chooses "Allow" (no script at all before that),
 *   - not on localhost or under browser automation, unless the server explicitly allows it for a test,
 *   - once per page load.
 * The passcode screen is server HTML that never runs this code.
 * Events are a fixed list of names with no values: no record ids, names, roles, free text or errors.
 * Withdrawal tells Clarity to clear its cookies, then reloads so the script is gone.
 */
export const EVENTS = ["project_entered", "scenario_started", "evidence_check_run", "scenario_completed", "audit_export_clicked"] as const;
export type AnalyticsEvent = (typeof EVENTS)[number];
export type AnalyticsSettings = { provider: "clarity"; projectId: string; allowLocal: boolean } | null;
export type Consent = "granted" | "denied" | null;

export const CONSENT_KEY = "eb.analytics.consent";
const ENTERED_KEY = "eb.analytics.entered";
const PROJECT_ID = /^[a-z0-9]{6,20}$/i;

type ClarityFn = ((...args: unknown[]) => void) & { q?: unknown[] };
type Win = { clarity?: ClarityFn; __ebClarityInstalled?: boolean };

export function environmentAllows(s: AnalyticsSettings, env: { hostname: string; webdriver: boolean }): boolean {
  if (!s || s.provider !== "clarity" || !PROJECT_ID.test(s.projectId)) return false;
  const local = env.hostname === "localhost" || env.hostname === "127.0.0.1" || env.hostname === "[::1]" || env.hostname.endsWith(".localhost");
  return s.allowLocal || (!local && !env.webdriver);
}

export function readConsent(storage: Pick<Storage, "getItem"> | null): Consent {
  try {
    const v = storage?.getItem(CONSENT_KEY);
    return v === "granted" || v === "denied" ? v : null;
  } catch {
    return null;
  }
}
export function writeConsent(storage: Pick<Storage, "setItem"> | null, c: "granted" | "denied"): void {
  try { storage?.setItem(CONSENT_KEY, c); } catch { /* storage unavailable: the choice lasts for this page only */ }
}

let active = false;
let target: Win | null = null;

/** Official Clarity loader pattern (queue stub + async tag). Returns false if already installed on this page. */
export function installClarity(win: Win, doc: Document, projectId: string): boolean {
  if (!PROJECT_ID.test(projectId)) return false;
  target = win;
  if (win.__ebClarityInstalled) { active = true; return false; }
  win.__ebClarityInstalled = true;
  const stub: ClarityFn = (...args: unknown[]) => { (stub.q = stub.q || []).push(args); };
  win.clarity = win.clarity || stub;
  const t = doc.createElement("script");
  t.async = true;
  t.src = `https://www.clarity.ms/tag/${projectId}`;
  doc.head.appendChild(t);
  // No ad storage in this app. Analytics storage only because the visitor chose "Allow".
  win.clarity!("consentv2", { ad_Storage: "denied", analytics_Storage: "granted" });
  active = true;
  return true;
}

export function track(name: AnalyticsEvent): void {
  if (!active || !target?.clarity || !(EVENTS as readonly string[]).includes(name)) return;
  target.clarity("event", name);
}

/** Once per browser session (tab), not on every reload. */
export function trackEntered(session: Pick<Storage, "getItem" | "setItem"> | null): void {
  try {
    if (session?.getItem(ENTERED_KEY)) return;
    session?.setItem(ENTERED_KEY, "1");
  } catch { /* ignore */ }
  track("project_entered");
}

/** Stop: tell Clarity, then the caller reloads so no script remains. */
export function withdraw(): void {
  if (target?.clarity) {
    target.clarity("consentv2", { ad_Storage: "denied", analytics_Storage: "denied" });
    target.clarity("consent", false);
  }
  active = false;
}

const OPEN = new Set(["AWAITING_CONFIRMATION", "EVALUATING", "EXECUTING", "FAILED_RETRYABLE"]);
/** Maps a finished UI action to event names. Reads only the run status, never ids or content. */
export function eventsFor(action: string, result: unknown): AnalyticsEvent[] {
  const status = (result as { run?: { status?: string } } | null)?.run?.status;
  const done = typeof status === "string" && !OPEN.has(status);
  if (action === "load") return ["scenario_started"];
  if (action === "check") return done ? ["evidence_check_run", "scenario_completed"] : ["evidence_check_run"];
  if (action === "stage") return done ? ["scenario_completed"] : [];
  return [];
}

/** For tests only. */
export function _resetForTests(): void { active = false; target = null; }
