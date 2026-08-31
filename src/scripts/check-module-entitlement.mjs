import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadModuleManifest } from "./permission-key-extractors.mjs";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const PILOT_MODULE = "timesheets";

function checkEntitlement(pilotEntry, planGatedIds) {
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

const args = process.argv.slice(2);

if (args.includes("--self-test")) {
  const checks = {};

  const planGated = ["timesheets", "hr", "crm"];

  const r1 = checkEntitlement({ id: "timesheets", planGated: false, storedKey: "TIMESHEETS" }, planGated);
  checks.planGatedMismatchDetected = !r1.ok;

  const r2 = checkEntitlement({ id: "timesheets", planGated: true, storedKey: "timesheets" }, planGated);
  checks.storedKeyLowercaseDetected = !r2.ok;

  const r3 = checkEntitlement({ id: "timesheets", planGated: true, storedKey: "TIMESHEETS_WRONG" }, planGated);
  checks.storedKeyWrongValueDetected = !r3.ok;

  const r4 = checkEntitlement({ id: "timesheets", planGated: true, storedKey: "TIMESHEETS" }, planGated);
  checks.correctEntitlementPasses = r4.ok;

  const r5 = checkEntitlement({ id: "chat", planGated: false, storedKey: "CHAT" }, planGated);
  checks.nonPlanGatedCorrectPasses = r5.ok;

  const r6 = checkEntitlement({ id: "chat", planGated: false, storedKey: "CHAT" }, ["chat", ...planGated]);
  checks.nonPlanGatedInCatalogDetected = !r6.ok;

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

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
