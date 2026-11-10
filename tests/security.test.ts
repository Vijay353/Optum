/** Repository hygiene: no real secrets committed; .env.example holds only dummy values. */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP = new Set(["node_modules", "dist", ".git", "test-results", "playwright-report", "runtime"]);
function files(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (SKIP.has(f)) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|js|json|md|csv|txt|example|html|css)$/.test(p) || f.startsWith(".env")) out.push(p);
  }
  return out;
}

describe("secrets hygiene", () => {
  it("no real-looking API keys or private keys in tracked source", () => {
    const hits = files(".").filter((f) => {
      const t = readFileSync(f, "utf8");
      return /sk-ant-(?!REPLACE_ME)[A-Za-z0-9_-]{16,}/.test(t) || /-----BEGIN (RSA |EC )?PRIVATE KEY-----/.test(t);
    });
    expect(hits).toEqual([]);
  });
  it(".env.example contains only dummy credential values", () => {
    const env = readFileSync(".env.example", "utf8");
    for (const line of env.split("\n").filter((l) => /SECRET|KEY|CLIENT_ID/.test(l) && l.includes("="))) {
      expect(line).toMatch(/REPLACE_ME|dummy|\/path\/to/);
    }
  });
  it("the browser code never imports server-only modules", () => {
    const ui = files("src/ui");
    for (const f of ui) {
      const t = readFileSync(f, "utf8");
      expect(t, f).not.toMatch(/from "node:|persistence\/db|simulators\/shared|adapters\/http"/);
    }
  });
});
