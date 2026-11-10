import type { z } from "zod";
/**
 * Minimal typed HTTP client used by every adapter.
 * - per-call timeout (AbortController)
 * - bounded retries with exponential backoff + full jitter, only for
 *   retryable failures (timeout, network, 429, 500, 502, 503, 504)
 * - callers opt in to retries for writes only when an idempotency key exists
 * - every attempt is reported to an onCall hook for the execution trace
 *   (no bodies are reported — only method, path, status, timing)
 */
export type HttpCallRecord = {
  system: string;
  method: string;
  path: string;
  status: number | null;
  outcome: "ok" | "http_error" | "timeout" | "network_error";
  attempt: number;
  durationMs: number;
};

export class UpstreamError extends Error {
  constructor(
    public readonly system: string,
    /** "contract" = the response arrived but did not match the expected schema (V3 CH-2). Never retried. */
    public readonly kind: "timeout" | "network" | "http" | "contract",
    public readonly status: number | null,
    public readonly body: unknown,
    public readonly attempts: number,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
  get retryable(): boolean {
    if (this.kind === "contract") return false;
    return this.kind !== "http" || RETRYABLE.has(this.status ?? 0);
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export type HttpClientOptions = {
  system: string;
  baseUrl: string;
  token: string;
  timeoutMs: number;
  maxRetries: number;
  baseBackoffMs: number;
  onCall?: (rec: HttpCallRecord) => void;
  /** Sent on every request (CH-20: the in-process marker that passes the access gate). Never traced. */
  defaultHeaders?: Record<string, string>;
};

export type RequestOptions = {
  query?: Record<string, string | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  retry?: boolean;
  parse?: "json" | "text";
};

export type HttpResult<T> = { status: number; body: T; headers: Headers; attempts: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpClient {
  onCall?: (rec: HttpCallRecord) => void;
  constructor(private readonly opts: HttpClientOptions) {
    this.onCall = opts.onCall;
  }

  async request<T>(method: string, path: string, ro: RequestOptions = {}): Promise<HttpResult<T>> {
    const url = new URL(path.replace(/^\//, ""), this.opts.baseUrl.endsWith("/") ? this.opts.baseUrl : this.opts.baseUrl + "/");
    for (const [k, v] of Object.entries(ro.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const maxAttempts = ro.retry === false ? 1 : 1 + this.opts.maxRetries;
    let lastErr: UpstreamError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
      const shownPath = url.pathname + url.search;
      try {
        const res = await fetch(url, {
          method,
          signal: ctrl.signal,
          headers: {
            authorization: `Bearer ${this.opts.token}`,
            accept: "application/json, text/plain",
            ...(ro.body !== undefined ? { "content-type": "application/json" } : {}),
            ...this.opts.defaultHeaders,
            ...ro.headers,
          },
          body: ro.body !== undefined ? JSON.stringify(ro.body) : undefined,
        });
        const text = await res.text();
        clearTimeout(timer);
        const rec: HttpCallRecord = {
          system: this.opts.system, method, path: shownPath, status: res.status,
          outcome: res.ok ? "ok" : "http_error", attempt, durationMs: Date.now() - started,
        };
        this.onCall?.(rec);
        const body = ro.parse === "text" ? text : safeJson(text);
        if (res.ok) return { status: res.status, body: body as T, headers: res.headers, attempts: attempt };
        lastErr = new UpstreamError(this.opts.system, "http", res.status, body, attempt, `${this.opts.system} ${method} ${url.pathname} → ${res.status}`);
        if (!RETRYABLE.has(res.status) || attempt === maxAttempts) throw lastErr;
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 2000) : this.backoff(attempt));
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof UpstreamError) throw err;
        const timedOut = (err as Error).name === "AbortError";
        this.onCall?.({
          system: this.opts.system, method, path: shownPath, status: null,
          outcome: timedOut ? "timeout" : "network_error", attempt, durationMs: Date.now() - started,
        });
        lastErr = new UpstreamError(this.opts.system, timedOut ? "timeout" : "network", null, null, attempt,
          `${this.opts.system} ${method} ${url.pathname} ${timedOut ? `timed out after ${this.opts.timeoutMs}ms` : "network error"}`);
        if (attempt === maxAttempts) throw lastErr;
        await sleep(this.backoff(attempt));
      }
    }
    throw lastErr ?? new Error("unreachable");
  }

  /**
   * Like request(), but validates the response body against a schema (V3 CH-2).
   * A body that does not match throws UpstreamError kind "contract"; values are
   * never defaulted into something valid.
   */
  async requestParsed<S extends z.ZodType>(method: string, path: string, schema: S, ro: RequestOptions = {}): Promise<HttpResult<z.infer<S>>> {
    const r = await this.request<unknown>(method, path, ro);
    const parsed = schema.safeParse(r.body);
    if (!parsed.success) {
      const detail = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ");
      throw new UpstreamError(this.opts.system, "contract", r.status, null, r.attempts, `${this.opts.system} ${method} ${path.split("?")[0]} returned an unexpected body (${detail})`);
    }
    return { ...r, body: parsed.data };
  }

  private backoff(attempt: number): number {
    const cap = this.opts.baseBackoffMs * 2 ** (attempt - 1);
    return Math.round(cap / 2 + Math.random() * (cap / 2));
  }
}

function safeJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}
