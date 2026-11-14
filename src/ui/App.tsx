import { useEffect, useState } from "react";
import { apiClient, getRole, setRole, type Health, type Role } from "./api";
import { EvidenceBridgePage } from "./EvidenceBridgePage";
import { DataStudio } from "./DataStudio";
import { didInstallFail, environmentAllows, installClarity, readConsent, trackEntered, withdraw, writeConsent, type Consent } from "./analytics";

const storage = (kind: "localStorage" | "sessionStorage"): Storage | null => {
  try { return window[kind]; } catch { return null; }
};

type Tab = "review" | "data";

export function App() {
  const [tab, setTab] = useState<Tab>("review");
  const [role, setRoleState] = useState<Role>(getRole());
  const [health, setHealth] = useState<Health | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [consent, setConsent] = useState<Consent>(() => readConsent(storage("localStorage")));
  const [analyticsBlocked, setAnalyticsBlocked] = useState(false);
  const analytics = health?.analytics ?? null;
  const analyticsAvailable = environmentAllows(analytics, { hostname: window.location.hostname, webdriver: navigator.webdriver === true });

  // CH-21: load only after entry (settings exist only behind the gate) and only after "Allow".
  useEffect(() => {
    if (!analyticsAvailable || consent !== "granted" || !analytics) return;
    installClarity(window as never, document, analytics.projectId);
    trackEntered(storage("sessionStorage"));
    // If the tag failed (tracker blocker, offline), say so in the footer instead of failing silently.
    const t = window.setTimeout(() => { if (didInstallFail()) setAnalyticsBlocked(true); }, 5000);
    return () => window.clearTimeout(t);
  }, [analyticsAvailable, consent, analytics]);

  const choose = (c: "granted" | "denied") => {
    writeConsent(storage("localStorage"), c);
    setConsent(c);
    if (c === "denied" && consent === "granted") {
      withdraw();
      window.location.reload();
    }
  };

  useEffect(() => {
    apiClient.health().then(setHealth).catch(() => setHealth({ ok: false, mode: "unknown", extractor: null, configErrors: ["API is not reachable. Start it with npm run dev."] }));
  }, []);

  const changeRole = (r: Role) => {
    setRole(r);
    setRoleState(r);
    setRefreshKey((k) => k + 1);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 8h14M5 12h14M5 16h8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>
          </span>
          <span>
            <span className="brand-name">EvidenceBridge</span>
            <span className="brand-sub">Pre-submission evidence review · conceptual Optum Insight extension, not an official Optum product</span>
          </span>
        </div>
        <nav className="tabs" aria-label="Sections">
          <button className={tab === "review" ? "tab active" : "tab"} aria-current={tab === "review" ? "page" : undefined} onClick={() => setTab("review")}>Evidence review</button>
          <button className={tab === "data" ? "tab active" : "tab"} aria-current={tab === "data" ? "page" : undefined} onClick={() => setTab("data")}>Data Studio</button>
        </nav>
        <div className="topbar-right">
          <label className="role-select">
            <span>Acting as <em>(demo identity)</em></span>
            <select value={role} onChange={(e) => changeRole(e.target.value as Role)} aria-label="Demo identity">
              <option value="pa-specialist">PA specialist</option>
              <option value="viewer">Read-only viewer</option>
              <option value="sim-admin">Simulator admin</option>
            </select>
          </label>
          <span className="synthetic-badge" role="note"><span className="dot" aria-hidden="true" />SYNTHETIC DATA ONLY</span>
          {health?.accessGate && (
            <form method="post" action="/gate/logout" className="lock-form">
              <button type="submit" className="btn link" title="Lock the demo and return to the passcode screen">Lock demo</button>
            </form>
          )}
        </div>
      </header>

      {health && !health.ok && (
        <div className="config-banner" role="alert">
          <strong>Execution is blocked (fail closed).</strong> {health.configErrors.join(" ")}
          <div className="config-hint">Set <code>EB_MODE=SIMULATED</code> and <code>EB_EXTRACTOR=fixture</code> in <code>.env</code> to use the local simulators.</div>
        </div>
      )}

      {analyticsAvailable && consent === null && (
        <section className="consent-banner" aria-label="Analytics choice">
          <p>
            Help improve this demo? With your permission, Microsoft Clarity records anonymous usage (clicks, scrolling, which screens are used). The review screen is masked, and no passcode, record IDs or names are sent. Nothing is recorded unless you allow it.
          </p>
          <div className="row">
            <button className="btn primary" onClick={() => choose("granted")}>Allow analytics</button>
            <button className="btn secondary" onClick={() => choose("denied")}>No thanks</button>
          </div>
        </section>
      )}

      {/* CH-21: record contents are masked in any session recording. */}
      <main className="main" id="main" data-clarity-mask="true">
        {tab === "review" ? <EvidenceBridgePage key={`r${refreshKey}`} role={role} mode={health?.mode ?? null} onSwitchRole={changeRole} /> : <DataStudio key={`d${refreshKey}`} role={role} />}
      </main>

      <footer className="footer">
        Synthetic records only · Mode {health?.mode ?? "…"} · Extractor {health?.extractor ?? "…"} · The synthetic policy is fictional and is not InterQual, Optum CES or any payer policy.
        {analyticsAvailable && consent !== null && (
          <> · Analytics {consent === "granted" ? "on" : "off"}{" "}
            {consent === "granted" && analyticsBlocked && (
              <span role="note"> (couldn&apos;t load — a tracker blocker or adblocker may be stopping it; allow clarity.ms for this site)</span>
            )}{" "}
            <button className="btn link" onClick={() => choose(consent === "granted" ? "denied" : "granted")}>
              {consent === "granted" ? "Turn off analytics" : "Turn on analytics"}
            </button>
          </>
        )}
      </footer>
    </div>
  );
}
