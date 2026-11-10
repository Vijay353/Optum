/** Fails if server-only secrets, tokens or provider code leak into the browser bundle (run after `npm run build`). */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [/eb-orchestrator-local/, /eb-sim-admin-local/, /eb-demo-clinician-local/, /ANTHROPIC_API_KEY/, /x-api-key/i, /sk-ant-/, /api\.anthropic\.com/, /node:sqlite/,
  // CH-20: access gate secrets and internals are server-only. The PIN itself is never in source; a build-time PIN would show up by name here.
  /EB_ACCESS_PIN/, /EB_SESSION_SECRET/, /VITE_[A-Z_]*PIN/, /x-eb-internal/];
const files: string[] = [];
const walk = (d: string): void => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
};
walk("dist");
const hits = files.flatMap((f) => FORBIDDEN.filter((re) => re.test(readFileSync(f, "utf8"))).map((re) => `${f}: ${re}`));
if (hits.length) {
  console.error("Client bundle contains server-only material:\n" + hits.join("\n"));
  process.exit(1);
}
console.log(`Client bundle clean: ${files.length} files scanned, 0 forbidden patterns.`);
