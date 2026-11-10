/** Durable idempotency records for the mock EHR Task write (spec §13). */
import type { Db } from "./db";

export type IdempotencyRecord = { key: string; requestHash: string; responseJson: string; createdAt: string };

export function findIdempotency(db: Db, key: string): IdempotencyRecord | null {
  const row = db.prepare("SELECT key, request_hash, response_json, created_at FROM ehr_idempotency WHERE key = ?").get(key) as
    | { key: string; request_hash: string; response_json: string; created_at: string }
    | undefined;
  return row ? { key: row.key, requestHash: row.request_hash, responseJson: row.response_json, createdAt: row.created_at } : null;
}

export function saveIdempotency(db: Db, rec: IdempotencyRecord): void {
  db.prepare("INSERT INTO ehr_idempotency (key, request_hash, response_json, created_at) VALUES (?,?,?,?)").run(
    rec.key, rec.requestHash, rec.responseJson, rec.createdAt,
  );
}
