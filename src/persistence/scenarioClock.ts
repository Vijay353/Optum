/**
 * Scenario clock (V3 CH-0B). Each scenario fixture fixes a start time
 * (`scenarioTime`). The clock starts there when the scenario is loaded and
 * then moves forward with real elapsed time, plus any demo "move time
 * forward" offset. With no scenario time set it falls back to the system clock.
 * State lives in app_meta so every part of the process sees the same time.
 */
import type { Clock } from "../domain/clock";
import type { Db } from "./db";

const K = { anchor: "clock.anchor", start: "clock.realStartMs", offset: "clock.offsetMs" } as const;

function getMeta(db: Db, key: string): string | null {
  return (db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
}
function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export type ClockState = { mode: "scenario" | "system"; now: string; anchor: string | null; offsetMs: number };

export class ScenarioClock implements Clock {
  constructor(private readonly db: Db, private readonly realNow: () => number = () => Date.now()) {}
  now(): Date {
    const anchor = getMeta(this.db, K.anchor);
    const offset = Number(getMeta(this.db, K.offset) ?? 0);
    if (!anchor) return new Date(this.realNow() + offset);
    const start = Number(getMeta(this.db, K.start) ?? this.realNow());
    return new Date(Date.parse(anchor) + (this.realNow() - start) + offset);
  }
  state(): ClockState {
    const anchor = getMeta(this.db, K.anchor);
    return { mode: anchor ? "scenario" : "system", now: this.now().toISOString(), anchor, offsetMs: Number(getMeta(this.db, K.offset) ?? 0) };
  }
}

/** Starts the scenario clock at `anchorIso` (or clears it when null). Resets any offset. */
export function setScenarioTime(db: Db, anchorIso: string | null, realNow: () => number = () => Date.now()): void {
  if (anchorIso) {
    setMeta(db, K.anchor, new Date(anchorIso).toISOString());
    setMeta(db, K.start, String(realNow()));
  } else {
    db.prepare("DELETE FROM app_meta WHERE key IN (?, ?)").run(K.anchor, K.start);
  }
  setMeta(db, K.offset, "0");
}

/** Demo control: moves scenario time forward. Never backward. */
export function advanceScenarioClock(db: Db, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) throw new RangeError("advance must be a positive number of milliseconds");
  setMeta(db, K.offset, String(Number(getMeta(db, K.offset) ?? 0) + ms));
}
