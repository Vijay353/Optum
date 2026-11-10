/**
 * First-install bootstrap (V3 CH-22). Loads the sample scenario ONLY if the database is empty.
 * Safe to rerun: on a database with records it changes nothing.
 * (npm run seed is different: it resets. Use it only on throwaway demo databases.)
 */
import { loadConfig } from "../src/server/config";
import { openDb } from "../src/persistence/db";
import { loadScenario } from "../src/server/scenarios";
import { assertWritableDataDir, startupSeedDecision } from "../src/server/bootstrap";

const config = loadConfig();
assertWritableDataDir(config.dbPath);
const db = openDb(config.dbPath);
const d = startupSeedDecision(db, { ...process.env, EB_BOOTSTRAP: "seed-if-empty" });
if (d.action === "seed") loadScenario(db, "primary-success");
console.log(`${d.action === "seed" ? "Seeded" : "Unchanged"}: ${d.reason} (${config.dbPath})`);
db.close();
