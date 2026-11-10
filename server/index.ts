/**
 * Entry point: one process hosting the four simulators, the orchestrator API
 * and (in production mode) the built React UI. Binds 127.0.0.1 unless EB_HOST
 * says otherwise (the container sets 0.0.0.0).
 */
import { loadConfig } from "../src/server/config";
import { openDb } from "../src/persistence/db";
import { createApp } from "../src/server/app";
import { loadScenario } from "../src/server/scenarios";
import { assertWritableDataDir, startupSeedDecision } from "../src/server/bootstrap";
import { log } from "../src/server/logger";

const config = loadConfig();
if (config.startupErrors.length) {
  for (const e of config.startupErrors) log("error", e);
  log("error", "Refusing to start. Fix the access gate settings above (see docs/DEPLOYMENT.md).");
  process.exit(1);
}
try {
  assertWritableDataDir(config.dbPath);
} catch (err) {
  log("error", (err as Error).message);
  process.exit(1);
}
for (const w of config.warnings) log("warn", w);
const db = openDb(config.dbPath);
const seed = startupSeedDecision(db);
if (seed.action === "seed") loadScenario(db, "primary-success");
log(seed.action === "wait" ? "warn" : "info", seed.reason, { dbPath: config.dbPath });
const { app, setBaseUrl } = createApp({ db, config });
const server = app.listen(config.port, config.host, () => {
  // In-process simulator calls always go over loopback, whatever the public bind address.
  setBaseUrl(`http://127.0.0.1:${config.port}`);
  log("info", "EvidenceBridge listening", { url: `http://${config.host}:${config.port}`, mode: config.mode });
  if (config.errors.length) log("warn", "configuration blocks execution (fail closed)", { errors: config.errors.join(" | ") });
});
const shutdown = () => server.close(() => { db.close(); process.exit(0); });
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
