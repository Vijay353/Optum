/**
 * Configuration + mode selection. SIMULATED is the only fully runnable mode.
 * SANDBOX/LIVE fail closed until real adapters are configured AND verified.
 */
import { gateConfigFrom, type GateConfig } from "./accessGate";

export type Mode = "SIMULATED" | "SANDBOX" | "LIVE";

export type Config = {
  mode: Mode;
  port: number;
  /** CH-22: bind address. Loopback by default; the container sets 0.0.0.0. */
  host: string;
  dbPath: string;
  httpTimeoutMs: number;
  httpMaxRetries: number;
  httpBaseBackoffMs: number;
  extractor: "fixture" | "llm";
  anthropicApiKey: string | undefined;
  llmModel: string;
  requestingProviderOrgId: string;
  /** CH-0A: an evaluated run older than this cannot be staged; it must be checked again. */
  maxRunAgeHours: number;
  /** CH-20: visitor access gate. Separate from the demo role switch. */
  gate: GateConfig;
  /** CH-21: public Clarity project id (an identifier, not a secret). Sent to the browser only after gate entry. */
  analytics: { provider: "clarity"; projectId: string; allowLocal: boolean } | null;
  warnings: string[];
  /** Problems that must stop the process at startup (unlike `errors`, which block execution only). */
  startupErrors: string[];
  errors: string[];
};

const REQUIRED_FOR_REAL = [
  "EB_EHR_FHIR_BASE_URL",
  "EB_EHR_CLIENT_ID",
  "EB_EHR_CLIENT_SECRET",
  "EB_PAYER_PROVIDER_ACCESS_BASE_URL",
  "EB_PAYER_CLIENT_ID",
  "EB_PAYER_CLIENT_SECRET",
  "EB_HIE_BASE_URL",
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const errors: string[] = [];
  const modeRaw = (env.EB_MODE ?? "SIMULATED").toUpperCase();
  const mode: Mode = modeRaw === "SANDBOX" || modeRaw === "LIVE" ? modeRaw : "SIMULATED";
  if (!["SIMULATED", "SANDBOX", "LIVE"].includes(modeRaw)) errors.push(`Unknown EB_MODE "${env.EB_MODE}".`);
  if (mode !== "SIMULATED") {
    const missing = REQUIRED_FOR_REAL.filter((k) => !env[k] || /dummy|example\.invalid|REPLACE_ME/i.test(env[k] ?? ""));
    if (missing.length) errors.push(`${mode} mode requires real values for: ${missing.join(", ")}.`);
    errors.push(`${mode} adapters are skeletons (NOT_VERIFIED) and refuse to run. Set EB_MODE=SIMULATED to use the local simulators.`);
    if (mode === "LIVE" && env.EB_ALLOW_LIVE !== "true") errors.push("LIVE mode additionally requires EB_ALLOW_LIVE=true and must never be the default.");
  }
  const extractor = (env.EB_EXTRACTOR ?? "fixture") === "llm" ? "llm" : "fixture";
  if (extractor === "llm" && (!env.ANTHROPIC_API_KEY || /REPLACE_ME|dummy/i.test(env.ANTHROPIC_API_KEY))) {
    errors.push("EB_EXTRACTOR=llm requires a server-side ANTHROPIC_API_KEY. Set EB_EXTRACTOR=fixture to use the deterministic extractor.");
  }
  const host = env.EB_HOST ?? "127.0.0.1";
  const { gate, errors: startupErrors } = gateConfigFrom(env, host);
  const warnings: string[] = [];
  const clarityId = env.EB_CLARITY_PROJECT_ID?.trim();
  let analytics: Config["analytics"] = null;
  if (clarityId) {
    if (/^[a-z0-9]{6,20}$/i.test(clarityId)) analytics = { provider: "clarity", projectId: clarityId, allowLocal: env.EB_ANALYTICS_ALLOW_LOCAL === "true" };
    else warnings.push("EB_CLARITY_PROJECT_ID does not look like a Clarity project id. Analytics stays off.");
  }
  return {
    mode,
    port: Number(env.EB_PORT ?? env.PORT ?? 8787),
    host,
    dbPath: env.EB_DB_PATH ?? env.DATABASE_PATH ?? "data/runtime/evidencebridge.sqlite",
    httpTimeoutMs: Number(env.EB_HTTP_TIMEOUT_MS ?? 1500),
    httpMaxRetries: Number(env.EB_HTTP_MAX_RETRIES ?? 2),
    httpBaseBackoffMs: Number(env.EB_HTTP_BACKOFF_MS ?? 100),
    extractor,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    llmModel: env.EB_LLM_MODEL ?? "claude-sonnet-5-5",
    requestingProviderOrgId: env.EB_REQUESTING_PROVIDER_ORG ?? "SYN-ORG-ORTHO-100",
    maxRunAgeHours: positiveNumber(env.EB_MAX_RUN_AGE_HOURS, 24, "EB_MAX_RUN_AGE_HOURS", errors),
    gate,
    analytics,
    warnings,
    startupErrors,
    errors,
  };
}

function positiveNumber(raw: string | undefined, fallback: number, name: string, errors: string[]): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    errors.push(`${name} must be a positive number, got "${raw}".`);
    return fallback;
  }
  return n;
}
