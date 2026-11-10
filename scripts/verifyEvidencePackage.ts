/** Verifies an exported evidence package digest. Usage: npx tsx scripts/verifyEvidencePackage.ts <file.json> */
import { readFileSync } from "node:fs";
import { verifyPackageDigest } from "../src/orchestrator/evidencePackage";

const file = process.argv[2];
if (!file) {
  console.error("usage: verifyEvidencePackage <file.json>");
  process.exit(2);
}
const r = verifyPackageDigest(JSON.parse(readFileSync(file, "utf8")));
console.log(r.ok ? `Digest matches (${r.expected}). The file has not changed since export. This is a checksum, not a signature.` : `Digest does NOT match. Expected ${r.expected}, file says ${r.actual}.`);
process.exit(r.ok ? 0 : 1);
