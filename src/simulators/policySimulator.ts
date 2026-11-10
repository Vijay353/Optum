/**
 * Synthetic policy service. Serves fictional, versioned documentation
 * checklists. NOT InterQual, NOT Optum CES, NOT any payer's medical policy.
 */
import { Router } from "express";
import type { Db } from "../persistence/db";
import { operationOutcome, requireScope } from "./shared";

export function createPolicyRouter(db: Db): Router {
  const r = Router();
  r.get("/policies/:policyVersion", requireScope("Policy.read"), (req, res) => {
    const p = db.prepare("SELECT * FROM policy_versions WHERE policy_version = ?").get(String(req.params.policyVersion)) as Record<string, string | null> | undefined;
    if (!p) return void res.status(404).json(operationOutcome("not-found", "policy version not found"));
    res.json({
      policyVersion: p.policy_version,
      status: p.status,
      serviceCategory: p.service_category,
      label: p.label,
      effectiveFrom: p.effective_from,
      effectiveTo: p.effective_to,
      requirements: JSON.parse(String(p.requirements_json)),
      synthetic: true,
    });
  });
  return r;
}
