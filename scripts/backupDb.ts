/**
 * Consistent backup with a restore check. Usage: npm run backup -- [destDir]
 * Default destDir: EB_BACKUP_DIR or <db dir>/backups. Keeps EB_BACKUP_KEEP (default 14) newest copies.
 * A backup on the same disk is not off-host. Copy the file off the server (see docs/DEPLOYMENT.md).
 */
import { dirname, join } from "node:path";
import { loadConfig } from "../src/server/config";
import { openDb } from "../src/persistence/db";
import { backupAndVerify } from "../src/persistence/backup";

const config = loadConfig();
const dest = process.argv[2] ?? process.env.EB_BACKUP_DIR ?? join(dirname(config.dbPath), "backups");
const db = openDb(config.dbPath);
const r = await backupAndVerify(db, dest, { keep: Number(process.env.EB_BACKUP_KEEP ?? 14) });
db.close();
console.log(JSON.stringify({ file: r.file, matches: r.matches, counts: r.restored.counts, chains: r.restored.chains, integrity: r.restored.integrity, pruned: r.pruned }, null, 2));
if (!r.matches) {
  console.error("Backup copy does not match the source. Do not rely on it.");
  process.exit(1);
}
