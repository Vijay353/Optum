/**
 * Portfolio access gate (V3 CH-20).
 *
 * A four-digit passcode checked on the server, then a short-lived signed
 * HttpOnly session cookie. It covers the app document, deep links, static
 * assets, the API and the simulators. Only /healthz and the /gate routes are
 * open. It is a convenience gate for a demo with synthetic data: four digits
 * are 10,000 combinations, so this is NOT strong authentication.
 *
 * It is separate from the demo role switch (x-demo-role, CH-13). Passing the
 * gate gives no role; the role switch never opens the gate.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";

export type GateConfig = {
  enabled: boolean;
  pin: string | null;
  secret: string | null;
  ttlMs: number;
  secureCookie: boolean;
  /** Number of trusted reverse proxies in front of the app, or false. */
  trustProxy: number | false;
};

export const GATE_OFF: GateConfig = { enabled: false, pin: null, secret: null, ttlMs: 0, secureCookie: false, trustProxy: false };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
export const isLoopbackHost = (host: string) => LOOPBACK_HOSTS.has(host);

/**
 * The gate is required whenever the server listens on a non-loopback address.
 * It may be off only on loopback (local development and automated tests), and only by default.
 * Problems are returned as startup errors: the server must refuse to start.
 */
export function gateConfigFrom(env: NodeJS.ProcessEnv, host: string): { gate: GateConfig; errors: string[] } {
  const errors: string[] = [];
  const loopback = isLoopbackHost(host);
  const flag = env.EB_ACCESS_GATE?.toLowerCase();
  if (flag !== undefined && flag !== "on" && flag !== "off") errors.push(`EB_ACCESS_GATE must be "on" or "off", got "${env.EB_ACCESS_GATE}".`);
  if (flag === "off" && !loopback) errors.push(`The access gate cannot be turned off while the server listens on ${host}. It may be off only on 127.0.0.1 or localhost.`);
  const enabled = flag === "on" || !loopback;
  let trustProxy: number | false = false;
  if (env.EB_TRUST_PROXY !== undefined && env.EB_TRUST_PROXY !== "") {
    const n = Number(env.EB_TRUST_PROXY);
    if (!Number.isInteger(n) || n < 1 || n > 3) errors.push("EB_TRUST_PROXY must be the number of reverse proxies in front of the app (1 to 3), or unset.");
    else trustProxy = n;
  }
  if (!enabled) return { gate: { ...GATE_OFF, trustProxy }, errors };

  const pin = env.EB_ACCESS_PIN ?? "";
  const secret = env.EB_SESSION_SECRET ?? "";
  if (!/^\d{4}$/.test(pin)) errors.push("EB_ACCESS_PIN must be exactly 4 digits when the access gate is on.");
  if (secret.length < 32 || /REPLACE_ME|dummy|changeme/i.test(secret)) errors.push("EB_SESSION_SECRET must be at least 32 random characters when the access gate is on (for example: openssl rand -hex 32).");
  const ttlMin = env.EB_SESSION_TTL_MINUTES === undefined || env.EB_SESSION_TTL_MINUTES === "" ? 120 : Number(env.EB_SESSION_TTL_MINUTES);
  if (!Number.isFinite(ttlMin) || ttlMin < 1 || ttlMin > 24 * 60) errors.push("EB_SESSION_TTL_MINUTES must be between 1 and 1440.");
  return {
    gate: { enabled: true, pin, secret, ttlMs: Math.round((Number.isFinite(ttlMin) ? ttlMin : 120) * 60_000), secureCookie: !loopback, trustProxy },
    errors,
  };
}

export const COOKIE = "eb_access";
export const INTERNAL_HEADER = "x-eb-internal";

/** Attempt limits. Progressive per client, plus a global cap because client addresses can rotate. */
export const LIMITS = { freeFailures: 3, maxDelayMs: 15 * 60_000, globalWindowMs: 15 * 60_000, globalMaxFailures: 60 };

type Attempts = { failures: number; lockedUntil: number; lastAt: number };

export type AccessGate = {
  /** Mount first. Handles /gate routes and blocks everything else without a valid session. */
  middleware: express.Router;
  /** Headers that in-process simulator calls send so they pass the gate. Empty when the gate is off. */
  internalHeaders: Record<string, string>;
  /** For tests. */
  now: () => number;
};

export function createAccessGate(gate: GateConfig, opts: { now?: () => number } = {}): AccessGate {
  const now = opts.now ?? Date.now;
  const router = express.Router();
  if (!gate.enabled) return { middleware: router, internalHeaders: {}, now };

  const secret = gate.secret!;
  const internalKey = randomBytes(32).toString("hex");
  const pinMac = mac(secret, `pin:${gate.pin}`);
  const revoked = new Map<string, number>();
  const attempts = new Map<string, Attempts>();
  let globalFailures: number[] = [];

  const sign = (payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");
  const issue = () => {
    const exp = now() + gate.ttlMs;
    const nonce = randomBytes(16).toString("hex");
    const payload = `v1.${exp}.${nonce}`;
    return `${payload}.${sign(payload)}`;
  };
  const verify = (token: string | undefined): { nonce: string; exp: number } | null => {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") return null;
    const [, expRaw, nonce, sig] = parts as [string, string, string, string];
    const expected = Buffer.from(sign(`v1.${expRaw}.${nonce}`));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) || exp <= now() || revoked.has(nonce)) return null;
    return { nonce, exp };
  };
  const cookieAttrs = (maxAgeSec: number) =>
    `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${gate.secureCookie ? "; Secure" : ""}`;
  const sessionOf = (req: Request) => verify(readCookie(req.headers.cookie, COOKIE));
  const isInternal = (req: Request) => {
    const h = req.header(INTERNAL_HEADER);
    const addr = req.socket.remoteAddress ?? "";
    if (!h || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(addr)) return false;
    const a = Buffer.from(h);
    const b = Buffer.from(internalKey);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const prune = () => {
    const t = now();
    for (const [n, exp] of revoked) if (exp <= t) revoked.delete(n);
    globalFailures = globalFailures.filter((x) => x > t - LIMITS.globalWindowMs);
    // Forget a client only after it has been quiet for the longest delay and is not locked.
    for (const [k, a] of attempts) if (a.lastAt < t - LIMITS.maxDelayMs && a.lockedUntil <= t) attempts.delete(k);
  };

  router.get("/gate", (req, res) => {
    if (sessionOf(req)) return void res.redirect(303, safeNext(req.query.next));
    sendGatePage(res, 200, { next: safeNext(req.query.next) });
  });

  router.post("/gate/login", express.urlencoded({ extended: false, limit: "1kb", parameterLimit: 5 }), (req, res) => {
    prune();
    const t = now();
    const next = safeNext(req.body?.next);
    const client = req.ip ?? "unknown";
    const a = attempts.get(client) ?? { failures: 0, lockedUntil: 0, lastAt: t };
    const globalBlocked = globalFailures.length >= LIMITS.globalMaxFailures;
    if (a.lockedUntil > t || globalBlocked) {
      const waitMs = globalBlocked ? globalFailures[0]! + LIMITS.globalWindowMs - t : a.lockedUntil - t;
      const waitSec = Math.max(1, Math.ceil(waitMs / 1000));
      res.setHeader("retry-after", String(waitSec));
      return void sendGatePage(res, 429, { next, error: `Too many attempts. Try again in ${formatWait(waitSec)}.` });
    }
    const input = typeof req.body?.pin === "string" ? req.body.pin : "";
    const ok = /^\d{4}$/.test(input) && safeEqual(mac(secret, `pin:${input}`), pinMac);
    if (!ok) {
      a.failures += 1;
      a.lastAt = t;
      if (a.failures >= LIMITS.freeFailures) a.lockedUntil = t + Math.min(LIMITS.maxDelayMs, 1000 * 2 ** (a.failures - LIMITS.freeFailures));
      attempts.set(client, a);
      globalFailures.push(t);
      return void sendGatePage(res, 401, { next, error: "That passcode did not work. Check it and try again." });
    }
    attempts.delete(client);
    res.setHeader("set-cookie", `${COOKIE}=${issue()}; ${cookieAttrs(Math.floor(gate.ttlMs / 1000))}`);
    res.redirect(303, next);
  });

  router.post("/gate/logout", (req, res) => {
    const s = sessionOf(req);
    if (s) revoked.set(s.nonce, s.exp);
    res.setHeader("set-cookie", `${COOKIE}=; ${cookieAttrs(0)}`);
    res.redirect(303, "/gate");
  });

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/healthz") return next();
    if (isInternal(req) || sessionOf(req)) return next();
    if (req.path.startsWith("/api") || req.path.startsWith("/mock-")) {
      return void res.status(401).json({ error: "Access session missing or expired. Enter the passcode again.", gate: true });
    }
    if ((req.method === "GET" || req.method === "HEAD") && (req.headers.accept ?? "").includes("text/html")) {
      return void res.redirect(303, `/gate?next=${encodeURIComponent(req.originalUrl)}`);
    }
    res.status(401).type("text/plain").send("Access session required.");
  });

  return { middleware: router, internalHeaders: { [INTERNAL_HEADER]: internalKey }, now };
}

function mac(secret: string, s: string): Buffer {
  return createHmac("sha256", secret).update(s).digest();
}
function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** Only same-site relative paths. Anything else goes to "/". Never the gate itself. */
export function safeNext(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 512) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || /[\r\n\t]/.test(raw)) return "/";
  if (raw === "/gate" || raw.startsWith("/gate?") || raw.startsWith("/gate/")) return "/";
  return raw;
}

function formatWait(sec: number): string {
  if (sec < 60) return `${sec} second${sec === 1 ? "" : "s"}`;
  const m = Math.ceil(sec / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Self-contained page: inline style and one small inline script, both nonce-bound.
 * It loads nothing from anywhere, so no analytics or third-party request can run here.
 */
function sendGatePage(res: Response, status: number, o: { next: string; error?: string }) {
  const nonce = randomBytes(16).toString("base64");
  res.status(status);
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader(
    "content-security-policy",
    `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  );
  const err = o.error ? `<p class="error" id="pin-error" role="alert">${esc(o.error)}</p>` : "";
  const described = o.error ? "pin-hint pin-error" : "pin-hint";
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:,">
<title>EvidenceBridge</title>
<style nonce="${nonce}">
:root{--bg:#f6f8fa;--surface:#fff;--border:#d8dee6;--border-strong:#c3ccd6;--text:#111827;--muted:#5b6573;--accent:#c2410c;--accent-strong:#9a3412;--bad:#b42318;--bad-soft:#fef2f2;--bad-border:#f2a7a0;--focus:#2563eb;--radius:9px;--font:Inter,"Segoe UI",system-ui,-apple-system,Arial,sans-serif;--mono:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;color-scheme:light}
*{box-sizing:border-box}html,body{margin:0}
body{min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;line-height:1.45;padding:16px}
main{width:100%;max-width:380px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:28px 24px 22px;box-shadow:0 1px 2px rgba(17,24,39,.04)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.mark{width:30px;height:30px;border-radius:7px;background:var(--accent);color:#fff;display:grid;place-items:center;flex:none}
.name{display:block;font-weight:750;font-size:16px}.sub{display:block;font-size:11px;color:var(--muted)}
label{display:block;font-weight:650;font-size:14px;margin-bottom:4px}
.hint{color:var(--muted);font-size:12.5px;margin:0 0 14px}
.field{position:relative;margin-bottom:14px}
.pin{width:100%;font-family:var(--mono);font-size:22px;letter-spacing:.5em;padding:10px 12px;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--surface);color:var(--text)}
.pin:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.cells{display:none}
.enhanced .cells{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;pointer-events:none}
.enhanced .cell{height:56px;border:1px solid var(--border-strong);border-radius:var(--radius);display:grid;place-items:center;font-size:22px;background:var(--surface)}
.enhanced .cell.active{border-color:var(--focus);box-shadow:0 0 0 2px rgba(37,99,235,.25)}
.enhanced .pin{position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:text}
.enhanced .field:focus-within .cells{outline:3px solid var(--focus);outline-offset:3px;border-radius:12px}
.error{background:var(--bad-soft);border:1px solid var(--bad-border);color:var(--bad);border-radius:8px;padding:8px 10px;margin:0 0 14px;font-weight:600;font-size:13px}
.has-error .cell{border-color:var(--bad-border)}
button{width:100%;font:inherit;font-weight:650;background:var(--accent);color:#fff;border:0;border-radius:var(--radius);padding:11px 14px;cursor:pointer}
button:hover{background:var(--accent-strong)}button:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
button[disabled]{opacity:.7;cursor:progress}
.foot{margin:16px 0 0;font-size:11.5px;color:var(--muted)}
@media (prefers-reduced-motion:no-preference){.cell{transition:border-color .12s}}
</style>
</head>
<body>
<main>
  <div class="brand">
    <span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 8h14M5 12h14M5 16h8" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg></span>
    <span><span class="name">EvidenceBridge</span><span class="sub">Portfolio demo · synthetic data only</span></span>
  </div>
  <form method="post" action="/gate/login" id="gate" class="${o.error ? "has-error" : ""}" novalidate>
    <label for="pin">Passcode</label>
    <p class="hint" id="pin-hint">Enter the 4-digit passcode you were given.</p>
    ${err}
    <div class="field">
      <div class="cells" aria-hidden="true"><span class="cell"></span><span class="cell"></span><span class="cell"></span><span class="cell"></span></div>
      <input class="pin" id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" autocomplete="one-time-code" required autofocus aria-describedby="${described}"${o.error ? ' aria-invalid="true"' : ""}>
    </div>
    <input type="hidden" name="next" value="${esc(o.next)}">
    <button type="submit" id="go">Enter EvidenceBridge</button>
  </form>
  <p class="foot">A simple passcode keeps this demo private. It is not a login for real data.</p>
</main>
<script nonce="${nonce}">
(function(){var f=document.getElementById("gate"),i=document.getElementById("pin"),b=document.getElementById("go"),c=f.querySelectorAll(".cell");
f.classList.add("enhanced");
function draw(){var v=i.value;for(var k=0;k<4;k++){c[k].textContent=k<v.length?"\\u2022":"";c[k].classList.toggle("active",document.activeElement===i&&k===Math.min(v.length,3))}}
i.addEventListener("input",function(){var d=i.value.replace(/\\D/g,"").slice(0,4);if(d!==i.value)i.value=d;draw()});
i.addEventListener("focus",draw);i.addEventListener("blur",draw);
f.addEventListener("submit",function(e){if(!/^\\d{4}$/.test(i.value)){e.preventDefault();i.focus();return}b.disabled=true;b.textContent="Checking\\u2026"});
draw();})();
</script>
</body>
</html>`);
}
