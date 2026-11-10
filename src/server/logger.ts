/**
 * Application logger with redaction. Never logs document bodies; masks
 * synthetic patient/coverage identifiers so logs carry no direct identifiers.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/SYN-PAT-\d{3,6}/g, "SYN-PAT-****"],
  [/SYN-COV-\d{3,6}/g, "SYN-COV-****"],
];

export function redact(s: string): string {
  return PATTERNS.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
}

export type LogFields = Record<string, string | number | boolean | null | undefined>;

let silent = process.env.EB_LOG_SILENT === "1";
export function setLogSilent(v: boolean): void {
  silent = v;
}

export function log(level: "info" | "warn" | "error", msg: string, fields: LogFields = {}): void {
  if (silent) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg: redact(msg), ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === "string" ? redact(v) : v])) });
  (level === "error" ? console.error : console.log)(line);
}
