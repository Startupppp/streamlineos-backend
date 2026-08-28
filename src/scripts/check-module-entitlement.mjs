/**
 * check-module-entitlement.mjs
 *
 * Pilot check for the timesheets module: asserts that the manifest's planGated
 * field agrees with MODULE_CATALOG membership, and that the stored key
 * round-trips correctly through storedModuleKey / moduleIdFromStored.
 *
 * WHAT IT CHECKS (timesheets pilot only):
 *
 *   1. manifest.planGated must equal whether the module appears in the
 *      plan-gated list derived from the manifest.
 *
 *   2. storedKey must be the uppercase form of the module id
 *      (storedModuleKey convention: toUpperCase).
 *
 *   3. storedKey.toLowerCase() must round-trip back to the module id
 *      (moduleIdFromStored convention: toLowerCase).
 *
 * Usage:
 *   node src/scripts/check-module-entitlement.mjs [--self-test]
 *
 * Exit codes:
 *   0  — pilot checks pass
 *   1  — a check failed or --self-test failed
 *   2  — manifest could not be loaded
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadModuleManifest } from "./permission-key-extractors.mjs";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const PILOT_MODULE = "timesheets";

// ---------------------------------------------------------------------------
// Core check logic (pure, testable)
// ---------------------------------------------------------------------------

/**
 * @param {{ id: string, planGated: boolean, storedKey: string }} pilotEntry
 * @param {string[]} planGatedIds  All module IDs where planGated === true.
 * @returns {{ ok: boolean, reason: string | null }}
 */
export function checkEntitlement(pilotEntry, planGatedIds) {
  const inCatalog = planGatedIds.includes(pilotEntry.id);
  if (pilotEntry.planGated !== inCatalog) {
    return {
      ok: false,
      reason: `planGated=${pilotEntry.planGated} but ${pilotEntry.id} ${inCatalog ? "is" : "is not"} in the plan-gated list`,
    };
  }
  const expectedStored = pilotEntry.id.toUpperCase();
  if (pilotEntry.storedKey !== expectedStored) {
    return {
      ok: false,
      reason: `storedKey should be "${expectedStored}" (uppercase), got "${pilotEntry.storedKey}"`,
    };
  }
  const roundTripped = pilotEntry.storedKey.toLowerCase();
  if (roundTripped !== pilotEntry.id) {
    return {
      ok: false,
      reason: `round-trip failed: "${pilotEntry.id}" → "${pilotEntry.storedKey}" → "${roundTripped}"`,
    };
  }
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes("--self-test")) {
  const checks = {};

  const planGated = ["timesheets", "hr", "crm"];

  // planGated mismatch is detected
  const r1 = checkEntitlement({ id: "timesheets", planGated: false, storedKey: "TIMESHEETS" }, planGated);
  checks.planGatedMismatchDetected = !r1.ok;

  // storedKey not uppercase is detected
  const r2 = checkEntitlement({ id: "timesheets", planGated: true, storedKey: "timesheets" }, planGated);
  checks.storedKeyLowercaseDetected = !r2.ok;

  // storedKey with wrong value is detected
  const r3 = checkEntitlement({ id: "timesheets", planGated: true, storedKey: "TIMESHEETS_WRONG" }, planGated);
  checks.storedKeyWrongValueDetected = !r3.ok;

  // correct entry passes
  const r4 = checkEntitlement({ id: "timesheets", planGated: true, storedKey: "TIMESHEETS" }, planGated);
  checks.correctEntitlementPasses = r4.ok;

  // non-planGated module with correct storedKey passes when absent from planGated list
  const r5 = checkEntitlement({ id: "chat", planGated: false, storedKey: "CHAT" }, planGated);
  checks.nonPlanGatedCorrectPasses = r5.ok;

  // non-planGated module that somehow landed in the plan-gated list is detected
  const r6 = checkEntitlement({ id: "chat", planGated: false, storedKey: "CHAT" }, ["chat", ...planGated]);
  checks.nonPlanGatedInCatalogDetected = !r6.ok;

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let manifest;
try {
  manifest = loadModuleManifest();
} catch (err) {
  process.stderr.write(`Cannot load the module manifest: ${err.message}\n`);
  process.exit(2);
}

const pilotEntry = manifest.modules.find((m) => m.id === PILOT_MODULE);
if (!pilotEntry) {
  process.stderr.write(`Module "${PILOT_MODULE}" not found in manifest.\n`);
  process.exit(2);
}

const planGatedIds = manifest.modules
  .filter((m) => m.planGated)
  .map((m) => m.id);

const result = checkEntitlement(pilotEntry, planGatedIds);

if (result.ok) {
  console.log(`OK — ${PILOT_MODULE}: planGated=${pilotEntry.planGated}, storedKey="${pilotEntry.storedKey}" round-trips correctly.`);
  process.exit(0);
} else {
  console.error(`FAIL — ${PILOT_MODULE}: ${result.reason}`);
  process.exit(1);
}
