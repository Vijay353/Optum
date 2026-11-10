/**
 * Startup safety for a persistent database (V3 CH-22).
 * - The data directory must be writable, or the process stops with a clear error.
 * - A database that already holds records is never reseeded or reset on restart or redeploy.
 * - Seeding happens only on an empty database, and only when EB_BOOTSTRAP allows it.
 */
import { accessSync, constants, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Db } from "../persistence/db";
import { activeScenarioId } from "./scenarios";

export type SeedDecision = { action: "seed" | "keep" | "wait"; reason: string };

/** Throws with a plain message if the database directory cannot be created or written. */
export function assertWritableDataDir(dbPath: string): void {
  if (dbPath === ":memory:") return;
  const dir = dirname(resolve(dbPath));
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch (err) {
    throw new Error(`Database directory ${dir} is not writable (${(err as NodeJS.ErrnoException).code ?? "error"}). Mount a writable volume there or set EB_DB_PATH. Refusing to start.`, { cause: err });
  }
}

const count = (db: Db, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Holds records = any draft, run, audit row or import batch. */
export function databaseHasRecords(db: Db): boolean {
  return ["ehr_prior_auth_drafts", "app_runs", "ehr_audit", "app_audit", "app_import_batches"].some((t) => count(db, t) > 0);
}

/** EB_BOOTSTRAP: "seed-if-empty" (default) or "never". */
export function startupSeedDecision(db: Db, env: NodeJS.ProcessEnv = process.env): SeedDecision {
  if (activeScenarioId(db)) return { action: "keep", reason: "Existing database. No reseed on restart." };
  if (databaseHasRecords(db)) return { action: "keep", reason: "Database has records but no active scenario. Left unchanged." };
  const mode = env.EB_BOOTSTRAP ?? "seed-if-empty";
  if (mode === "never") return { action: "wait", reason: "Empty database and EB_BOOTSTRAP=never. Run npm run bootstrap to load the sample scenario." };
  if (mode !== "seed-if-empty") throw new Error(`Unknown EB_BOOTSTRAP "${mode}". Use seed-if-empty or never.`);
  return { action: "seed", reason: "Empty database. Loading the primary-success sample scenario once." };
}
