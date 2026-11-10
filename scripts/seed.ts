/** Reset the local database to a scenario (default primary-success). Usage: npm run seed -- [scenario-id] */
import { loadConfig } from "../src/server/config";
import { openDb } from "../src/persistence/db";
import { loadScenario, listScenarios } from "../src/server/scenarios";

const id = process.argv[2] ?? "primary-success";
const config = loadConfig();
const db = openDb(config.dbPath);
const sc = loadScenario(db, id);
console.log(`Loaded scenario "${sc.title}" (${sc.id}) into ${config.dbPath}`);
console.log(`Available: ${listScenarios().map((s) => s.id).join(", ")}`);
db.close();
