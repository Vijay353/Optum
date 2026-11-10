/** Deterministic scenario fixtures: reset the simulators to base data + scenario faults. */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Db } from "../persistence/db";
import { loadFixtureDataset, writeDataset } from "../data/datasetStore";
import { setFault, type FaultKey, type FaultConfig } from "../simulators/shared";
import { setScenarioTime } from "../persistence/scenarioClock";

export const FIXTURES_DIR = resolve(process.env.EB_FIXTURES_DIR ?? "fixtures");

const ScenarioSchema = z.object({
  id: z.string(),
  order: z.number(),
  title: z.string(),
  description: z.string(),
  draftId: z.string(),
  dataset: z.string(),
  /** V3 CH-6: opt-in overlay datasets added on top of the base dataset. */
  overlays: z.array(z.string()).optional(),
  /** CH-0B: fixed start time for the scenario clock. Optional for older fixtures (system clock). */
  scenarioTime: z.string().datetime({ offset: true }).optional(),
  faults: z.record(z.string(), z.object({ kind: z.enum(["timeout", "status", "latency", "behavior"]), status: z.number().optional(), delayMs: z.number().optional(), remaining: z.number().nullable().optional() })),
  expected: z.object({ decision: z.string(), outcomeState: z.string(), createsTask: z.boolean() }),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export function listScenarios(dir = FIXTURES_DIR): Scenario[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "scenario.json")))
    .map((d) => ScenarioSchema.parse(JSON.parse(readFileSync(join(dir, d.name, "scenario.json"), "utf8"))))
    .sort((a, b) => a.order - b.order);
}

export function loadScenario(db: Db, id: string, opts: { faultOverrides?: Partial<Record<FaultKey, FaultConfig>> } = {}, dir = FIXTURES_DIR): Scenario {
  const sc = listScenarios(dir).find((s) => s.id === id);
  if (!sc) throw new Error(`unknown scenario ${id}`);
  const { dataset, issues } = loadFixtureDataset([join(dir, sc.dataset), ...(sc.overlays ?? []).map((o) => join(dir, o))]);
  if (issues.length) throw new Error(`fixture dataset ${sc.dataset} is invalid: ${issues.map((i) => `${i.sheet}:${i.row} ${i.message}`).join("; ")}`);
  writeDataset(db, dataset, "replace");
  setScenarioTime(db, sc.scenarioTime ?? null);
  const faults = { ...sc.faults, ...opts.faultOverrides } as Record<string, FaultConfig>;
  for (const [k, cfg] of Object.entries(faults)) if (cfg) setFault(db, k as FaultKey, cfg);
  db.prepare("INSERT INTO app_meta (key, value) VALUES ('activeScenario', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(sc.id);
  return sc;
}

export function activeScenarioId(db: Db): string | null {
  return (db.prepare("SELECT value FROM app_meta WHERE key = 'activeScenario'").get() as { value: string } | undefined)?.value ?? null;
}
