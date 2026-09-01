#!/usr/bin/env node
/**
 * check-module-gate.mjs
 *
 * Validates that every controller in a plan-gated module folder carries
 * @RequireModule(<owning-module-id>).
 *
 * Two failure modes:
 *   WRONG_MODULE  – controller declares @RequireModule("X") but folder belongs to module "Y"
 *   MISSING_GATE  – plan-gated module folder, no @RequireModule, no class-level @Public()
 *
 * Usage:
 *   node src/scripts/check-module-gate.mjs           # real run
 *   node src/scripts/check-module-gate.mjs --self-test  # fixture smoke-test
 *
 * Allowlist: backend/.module-gate-allowlist.json
 *   {
 *     "modules/surveys/survey-public.controller.ts": "all handlers @Public(); respondent has no session"
 *   }
 * A stale allowlist entry (file no longer exists) is itself a hard failure.
 */

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(__dirname, "../..");
const SRC_ROOT = join(BACKEND_ROOT, "src");
const MODULES_DIR = join(SRC_ROOT, "modules");
const REGISTRY_PATH = join(SRC_ROOT, "common/rbac/module-registry.ts");
const ALLOWLIST_PATH = join(BACKEND_ROOT, ".module-gate-allowlist.json");
const CONTROLLER_MIN = 200;

function parseRegistry(src) {
  const arrayMatch = src.match(/export const MODULE_REGISTRY = \[([\s\S]*?)\] as const/);
  if (!arrayMatch) throw new Error("Cannot find MODULE_REGISTRY in " + REGISTRY_PATH);
  const arrayContent = arrayMatch[1];
  const entries = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < arrayContent.length; i++) {
    const ch = arrayContent[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const obj = arrayContent.slice(start, i + 1);
        const idMatch = obj.match(/\bid:\s*"([^"]+)"/);
        const planGatedMatch = obj.match(/\bplanGated:\s*(true|false)/);
        const mfMatch = obj.match(/\bmoduleFolder:\s*(?:"([^"]+)"|null)/);
        if (idMatch && planGatedMatch && mfMatch) {
          entries.push({
            id: idMatch[1],
            planGated: planGatedMatch[1] === "true",
            moduleFolder: mfMatch[1] ?? null,
          });
        }
        start = -1;
      }
    }
  }
  return entries;
}

function walkControllers(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...walkControllers(p));
    else if (e.name.endsWith(".controller.ts")) files.push(p);
  }
  return files;
}

function isClassLevelPublic(content) {
  return /@Public\(\)(?:\s*(?:@[A-Za-z$_][A-Za-z0-9$_]*(?:\([^)]*\))?\s*))*export\s+(?:abstract\s+)?class\s/.test(content);
}

function getClassLevelRequireModuleIds(content) {
  const ids = [];
  for (const m of content.matchAll(/@RequireModule\("([^"]+)"\)/g)) {
    const afterPos = m.index + m[0].length;
    const remainder = content.slice(afterPos, afterPos + 600);
    if (/^(?:\s*(?:@[A-Za-z$_][A-Za-z0-9$_]*(?:\([^)]*\))?\s*))*\s*export\s+(?:abstract\s+)?class\s/.test(remainder))
      ids.push(m[1]);
  }
  return ids;
}

function checkFile(content, rel, expectedId, isPlanGated, allowlist) {
  const errors = [];
  if (allowlist[rel]) return { errors, allowlistHit: true };
  if (isClassLevelPublic(content)) return { errors, allowlistHit: false };
  const foundIds = getClassLevelRequireModuleIds(content);
  if (foundIds.length > 0) {
    for (const id of foundIds) {
      if (id !== expectedId)
        errors.push(`WRONG_MODULE  ${rel}  declares @RequireModule("${id}") but folder expects @RequireModule("${expectedId}")`);
    }
  } else if (isPlanGated) {
    errors.push(`MISSING_GATE  ${rel}  is in plan-gated module "${expectedId}" but has no @RequireModule and no class-level @Public()`);
  }
  return { errors, allowlistHit: false };
}

function run(registrySrc, allowlist, verbose) {
  const registry = parseRegistry(registrySrc);
  const folderToModule = {};
  for (const entry of registry) {
    if (entry.moduleFolder) folderToModule[entry.moduleFolder] = entry;
  }

  const allErrors = [];
  let totalControllers = 0;
  const usedAllowlistKeys = new Set();

  for (const [folder, entry] of Object.entries(folderToModule)) {
    const dir = join(MODULES_DIR, folder);
    const files = walkControllers(dir);
    for (const file of files) {
      totalControllers++;
      const content = readFileSync(file, "utf8");
      const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
      const { errors, allowlistHit } = checkFile(content, rel, entry.id, entry.planGated, allowlist);
      if (allowlistHit) usedAllowlistKeys.add(rel);
      allErrors.push(...errors);
    }
  }

  for (const key of Object.keys(allowlist)) {
    const abs = join(SRC_ROOT, key);
    if (!existsSync(abs))
      allErrors.push(`STALE_ALLOWLIST  ${key}  is allowlisted but the file does not exist`);
  }

  if (totalControllers < CONTROLLER_MIN)
    allErrors.push(`VACUITY  found only ${totalControllers} controllers (minimum ${CONTROLLER_MIN}); scan may have missed files`);

  if (verbose || allErrors.length > 0) {
    console.log(`Scanned ${totalControllers} controllers across ${Object.keys(folderToModule).length} module folders.`);
  }

  return allErrors;
}

function selfTest() {
  console.log("Running --self-test...\n");
  let passed = 0;
  let failed = 0;

  function assert(label, condition) {
    if (condition) {
      console.log(`  PASS  ${label}`);
      passed++;
    } else {
      console.error(`  FAIL  ${label}`);
      failed++;
    }
  }

  const fakeRegistry = `
export const MODULE_REGISTRY = [
  {
    id: "alpha",
    displayName: "Alpha",
    planGated: true,
    administrable: true,
    ladder: "delegable",
    administersNamespaces: [],
    route: "/alpha",
    productKey: "alpha",
    moduleFolder: "alpha",
    schemaFolder: "alpha",
    publicExposure: false,
    cacheNamespaces: [],
  },
  {
    id: "beta",
    displayName: "Beta",
    planGated: false,
    administrable: true,
    ladder: "delegable",
    administersNamespaces: [],
    route: "/beta",
    productKey: "beta",
    moduleFolder: "beta",
    schemaFolder: "beta",
    publicExposure: false,
    cacheNamespaces: [],
  },
] as const satisfies readonly any[];
`;

  const correctGate = `
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("alpha")
@Controller("alpha/things")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class AlphaThingsController {}
`;

  const wrongGate = `
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("build")
@Controller("alpha/things")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class AlphaThingsController {}
`;

  const noGatePlanGated = `
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";

@Controller("alpha/things")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AlphaThingsController {}
`;

  const classPublic = `
@Public()
@Controller("public/alpha")
export class AlphaPublicController {}
`;

  const noGateNonPlanGated = `
@Controller("beta/things")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BetaThingsController {}
`;

  const allowlist = {};

  const registry = parseRegistry(fakeRegistry);
  assert("parseRegistry: finds 2 entries", registry.length === 2);
  assert("parseRegistry: alpha is planGated", registry[0]?.planGated === true);
  assert("parseRegistry: beta is not planGated", registry[1]?.planGated === false);

  const wrongGateErrors = checkFile(wrongGate, "modules/alpha/alpha-things.controller.ts", "alpha", true, allowlist).errors;
  assert("WRONG_MODULE fires when @RequireModule says 'build' but folder is 'alpha'", wrongGateErrors.some(e => e.startsWith("WRONG_MODULE")));

  const correctErrors = checkFile(correctGate, "modules/alpha/alpha-things.controller.ts", "alpha", true, allowlist).errors;
  assert("No error when @RequireModule is correct", correctErrors.length === 0);

  const missingErrors = checkFile(noGatePlanGated, "modules/alpha/alpha-things.controller.ts", "alpha", true, allowlist).errors;
  assert("MISSING_GATE fires for plan-gated module with no @RequireModule", missingErrors.some(e => e.startsWith("MISSING_GATE")));

  const classPublicErrors = checkFile(classPublic, "modules/alpha/alpha-public.controller.ts", "alpha", true, allowlist).errors;
  assert("Class-level @Public() suppresses MISSING_GATE", classPublicErrors.length === 0);

  const nonPlanGatedErrors = checkFile(noGateNonPlanGated, "modules/beta/beta-things.controller.ts", "beta", false, allowlist).errors;
  assert("No error for non-plan-gated module with no @RequireModule", nonPlanGatedErrors.length === 0);

  const allowlistHit = checkFile(wrongGate, "modules/alpha/alpha-things.controller.ts", "alpha", true, { "modules/alpha/alpha-things.controller.ts": "test" }).allowlistHit;
  assert("Allowlisted file is skipped", allowlistHit === true);

  const staleAllowlistErrors = [];
  const staleKey = "modules/alpha/nonexistent.controller.ts";
  const absPath = join(SRC_ROOT, staleKey);
  if (!existsSync(absPath))
    staleAllowlistErrors.push(`STALE_ALLOWLIST  ${staleKey}  is allowlisted but the file does not exist`);
  assert("STALE_ALLOWLIST fires for non-existent allowlist entry", staleAllowlistErrors.some(e => e.startsWith("STALE_ALLOWLIST")));

  const vacuityErrors = [];
  if (1 < CONTROLLER_MIN)
    vacuityErrors.push(`VACUITY  found only 1 controllers (minimum ${CONTROLLER_MIN}); scan may have missed files`);
  assert("VACUITY fires when controller count is below minimum", vacuityErrors.some(e => e.startsWith("VACUITY")));

  const registrySrc = readFileSync(REGISTRY_PATH, "utf8");
  const realRegistry = parseRegistry(registrySrc);
  const folderToModule = {};
  for (const e of realRegistry) {
    if (e.moduleFolder) folderToModule[e.moduleFolder] = e;
  }
  let realCount = 0;
  for (const folder of Object.keys(folderToModule)) {
    realCount += walkControllers(join(MODULES_DIR, folder)).length;
  }
  assert(`Anti-vacuity: real codebase has at least ${CONTROLLER_MIN} controllers (found ${realCount})`, realCount >= CONTROLLER_MIN);

  console.log(`\n--self-test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

const args = process.argv.slice(2);

if (args.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const allowlist = existsSync(ALLOWLIST_PATH)
  ? JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"))
  : {};

const registrySrc = readFileSync(REGISTRY_PATH, "utf8");
const errors = run(registrySrc, allowlist, args.includes("--verbose"));

if (errors.length > 0) {
  console.error("\ncheck-module-gate FAILED:");
  for (const e of errors) console.error("  " + e);
  process.exit(1);
} else {
  console.log("check-module-gate PASSED");
}
