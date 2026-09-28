#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(HERE, "..", "..");
const BUILD_ROOT = join(BACKEND_ROOT, "src", "modules", "build");
const CORE_ROOT = resolve(BUILD_ROOT, "core");
const TICKETS_ROOT = join(CORE_ROOT, "tickets");
const REPO_SCAN_ROOTS = [join(BACKEND_ROOT, "src"), join(BACKEND_ROOT, "test")];
const SELF_TEST = process.argv.includes("--self-test");

const SCAN_FLOOR = 20;
const REPO_SCAN_FLOOR = 500;
const CORE_REACH_FLOOR = 40;

const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']/g,
  /\bjest\.(?:mock|doMock|unmock|requireActual|requireMock|createMockFromModule)\s*\(\s*["']([^"']+)["']/g,
];

const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".d.ts", ".mts", ".mjs", ".js", ".json"];
const RESOLVE_INDEXES = ["index.ts", "index.tsx", "index.mts", "index.js"];

function resolvesToFile(target) {
  for (const extension of RESOLVE_EXTENSIONS) {
    const candidate = target + extension;
    if (existsSync(candidate) && statSync(candidate).isFile()) return true;
  }
  for (const indexName of RESOLVE_INDEXES) {
    if (existsSync(join(target, indexName))) return true;
  }
  return false;
}

function resolveSpecifier(specifier, fromDir) {
  if (specifier.startsWith(".")) return resolve(fromDir, specifier);
  if (specifier.startsWith("src/") || specifier.startsWith("test/")) {
    return resolve(BACKEND_ROOT, specifier);
  }
  return null;
}

function aimsInside(root, resolved) {
  return resolved === root || resolved.startsWith(root + sep);
}

export function collectSpecifiers(source) {
  const found = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of SPECIFIER_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of lines[i].matchAll(pattern)) {
        found.push({ line: i + 1, specifier: match[1], text: lines[i].trim().slice(0, 200) });
      }
    }
  }
  return found;
}

export function findCoreReaches(source, fromDir) {
  const reaches = [];
  for (const entry of collectSpecifiers(source)) {
    const resolved = resolveSpecifier(entry.specifier, fromDir);
    if (resolved === null || !aimsInside(CORE_ROOT, resolved)) continue;
    reaches.push({ ...entry, resolved });
  }
  return reaches;
}

export function findUnresolvedCoreReaches(source, fromDir) {
  return findCoreReaches(source, fromDir).filter((reach) => !resolvesToFile(reach.resolved));
}

export function findExternalTicketsReaches(source, fromDir) {
  if (aimsInside(CORE_ROOT, resolve(fromDir))) return [];
  const hits = [];
  for (const reach of findCoreReaches(source, fromDir)) {
    if (!aimsInside(TICKETS_ROOT, reach.resolved)) continue;
    const afterTickets = reach.resolved.slice(TICKETS_ROOT.length);
    if (afterTickets === "" || afterTickets === sep + "index") continue;
    if (!/\bfrom\s*["']/.test(reach.text)) continue;
    hits.push(reach);
  }
  return hits;
}

function collectRepoFiles() {
  const results = [];
  for (const root of REPO_SCAN_ROOTS) {
    if (!existsSync(root)) continue;
    collectTypeScriptFiles(root, results);
  }
  return results;
}

function collectTypeScriptFiles(dir, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTypeScriptFiles(full, results);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

export function findDeepCoreImports(source, fromDir) {
  const hits = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const match of line.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const importPath = match[1];
      const resolved = resolve(fromDir, importPath);
      if (!resolved.startsWith(CORE_ROOT + sep) && resolved !== CORE_ROOT) continue;
      const afterCore = resolved.slice(CORE_ROOT.length);
      const isTicketsBarrel =
        afterCore === "" ||
        afterCore === sep + "index" ||
        afterCore === sep + "tickets" ||
        afterCore === sep + "tickets" + sep + "index";
      if (!isTicketsBarrel) {
        hits.push({ line: i + 1, text: line.trim().slice(0, 200) });
      }
    }
  }
  return hits;
}

function isSiblingFile(filePath) {
  const normalized = resolve(filePath);
  return !normalized.startsWith(CORE_ROOT + sep) && normalized !== CORE_ROOT;
}

function main() {
  if (!existsSync(BUILD_ROOT)) {
    console.error(`check:build-core-surface FAILED — build root not found: ${BUILD_ROOT}`);
    process.exit(1);
  }
  const all = collectTypeScriptFiles(BUILD_ROOT);
  const siblings = all.filter(isSiblingFile);
  if (siblings.length < SCAN_FLOOR) {
    console.error(`check:build-core-surface FAILED — only ${siblings.length} sibling files found, floor is ${SCAN_FLOOR}; scan likely missed the module`);
    process.exit(1);
  }
  const violations = [];
  for (const file of siblings) {
    const source = readFileSync(file, "utf8");
    const fileDir = dirname(file);
    for (const hit of findDeepCoreImports(source, fileDir)) {
      violations.push(`${file}:${hit.line} — ${hit.text}`);
    }
  }
  if (violations.length) {
    console.error(`check:build-core-surface FAILED — ${violations.length} deep core import(s) across ${siblings.length} scanned sibling file(s)`);
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }

  const repoFiles = collectRepoFiles();
  if (repoFiles.length < REPO_SCAN_FLOOR) {
    console.error(`check:build-core-surface FAILED — only ${repoFiles.length} repo file(s) found, floor is ${REPO_SCAN_FLOOR}; scan likely missed src/ or test/`);
    process.exit(1);
  }
  const unresolved = [];
  const externalTickets = [];
  let coreReachCount = 0;
  for (const file of repoFiles) {
    const source = readFileSync(file, "utf8");
    const fileDir = dirname(file);
    coreReachCount += findCoreReaches(source, fileDir).length;
    for (const reach of findUnresolvedCoreReaches(source, fileDir)) {
      unresolved.push(`${relative(BACKEND_ROOT, file)}:${reach.line} — ${reach.specifier} (${reach.text})`);
    }
    for (const reach of findExternalTicketsReaches(source, fileDir)) {
      externalTickets.push(`${relative(BACKEND_ROOT, file)}:${reach.line} — ${reach.text}`);
    }
  }
  if (coreReachCount < CORE_REACH_FLOOR) {
    console.error(`check:build-core-surface FAILED — only ${coreReachCount} specifier(s) aimed into build/core, floor is ${CORE_REACH_FLOOR}; the resolver is not biting`);
    process.exit(1);
  }
  if (unresolved.length) {
    console.error(`check:build-core-surface FAILED — ${unresolved.length} specifier(s) aim into build/core but resolve to nothing on disk`);
    for (const v of unresolved) console.error(`  ${v}`);
    process.exit(1);
  }
  if (externalTickets.length) {
    console.error(`check:build-core-surface FAILED — ${externalTickets.length} import(s) from outside build/core reach past the core/tickets barrel`);
    for (const v of externalTickets) console.error(`  ${v}`);
    process.exit(1);
  }

  console.log(`OK — ${siblings.length} sibling submodule file(s) scanned; 0 deep core imports.`);
  console.log(`OK — ${repoFiles.length} repo file(s) scanned, ${coreReachCount} specifier(s) aimed into build/core; 0 unresolved, 0 external reaches past the core/tickets barrel.`);
  process.exit(0);
}

function selfTest() {
  const fakeDir = resolve(BUILD_ROOT, "entity");
  const bad = [
    `import { foo } from "../core/projects-tickets-update.service";`,
    `import { bar } from "../core/build-automation-actions.service";`,
    `import { baz } from "../core/tickets/projects-tickets-create.service";`,
    `import { qux } from "../core/tickets/some-internal";`,
  ];
  const good = [
    `import { foo } from "../core";`,
    `import { foo } from "../core/tickets";`,
    `import { foo } from "./some-file";`,
    `import { foo } from "../sibling-module";`,
    `import { foo } from "../../ai/core/gateway/ai-gateway.service";`,
    `import { foo } from "../../timesheets/core/entries-period.service";`,
  ];
  let failures = 0;
  for (const sample of bad) {
    if (findDeepCoreImports(sample, fakeDir).length === 0) {
      console.error(`FAIL: bad sample not detected — ${sample}`);
      failures += 1;
    }
  }
  for (const sample of good) {
    if (findDeepCoreImports(sample, fakeDir).length !== 0) {
      console.error(`FAIL: good sample flagged — ${sample}`);
      failures += 1;
    }
  }
  const unresolvedBad = [
    `jest.mock("./project-access", () => ({}));`,
    `jest.requireActual("./project-access");`,
    `import { foo } from "./definitely-not-a-file-xyz";`,
    `const x = require("./tickets/definitely-not-a-file-xyz");`,
  ];
  const unresolvedGood = [
    `jest.mock("./project-crud/project-access", () => ({}));`,
    `import { foo } from "./tickets";`,
    `import { foo } from "./index";`,
    `import { foo } from "../../../common/auth/principal";`,
  ];
  for (const sample of unresolvedBad) {
    if (findUnresolvedCoreReaches(sample, CORE_ROOT).length === 0) {
      console.error(`FAIL: unresolved core reach not detected — ${sample}`);
      failures += 1;
    }
  }
  for (const sample of unresolvedGood) {
    if (findUnresolvedCoreReaches(sample, CORE_ROOT).length !== 0) {
      console.error(`FAIL: resolvable core reach flagged — ${sample}`);
      failures += 1;
    }
  }

  const externalDir = join(BACKEND_ROOT, "src", "modules", "feedbucket");
  const ticketsBad = [
    `import { foo } from "../build/core/tickets/projects-tickets.service";`,
    `import type { Foo } from "../build/core/tickets/ticket-status.util";`,
    `import { foo } from "src/modules/build/core/tickets/projects-tickets-read.query";`,
  ];
  const ticketsGood = [
    `import { foo } from "../build/core/tickets";`,
    `import { foo } from "../build/core";`,
    `import { foo } from "../build/core/index";`,
    `jest.mock("../build/core/tickets/projects-tickets.service");`,
  ];
  for (const sample of ticketsBad) {
    if (findExternalTicketsReaches(sample, externalDir).length === 0) {
      console.error(`FAIL: external tickets-group reach not detected — ${sample}`);
      failures += 1;
    }
  }
  for (const sample of ticketsGood) {
    if (findExternalTicketsReaches(sample, externalDir).length !== 0) {
      console.error(`FAIL: sanctioned tickets-group reach flagged — ${sample}`);
      failures += 1;
    }
  }
  const intraCore = `import { ticketsScope } from "../tickets/tickets-scope";`;
  if (findExternalTicketsReaches(intraCore, join(CORE_ROOT, "analytics")).length !== 0) {
    console.error(`FAIL: intra-core sibling reach flagged as external — ${intraCore}`);
    failures += 1;
  }

  if (!existsSync(BUILD_ROOT)) {
    console.error(`FAIL: build root not found at ${BUILD_ROOT}`);
    failures += 1;
  } else {
    const all = collectTypeScriptFiles(BUILD_ROOT);
    const siblings = all.filter(isSiblingFile);
    if (siblings.length < SCAN_FLOOR) {
      console.error(`FAIL: anti-vacuity floor ${SCAN_FLOOR} not met; found ${siblings.length} sibling files`);
      failures += 1;
    } else {
      console.log(`  anti-vacuity: ${siblings.length} sibling files found (floor ${SCAN_FLOOR})`);
    }
    const repoFiles = collectRepoFiles();
    if (repoFiles.length < REPO_SCAN_FLOOR) {
      console.error(`FAIL: repo anti-vacuity floor ${REPO_SCAN_FLOOR} not met; found ${repoFiles.length} files`);
      failures += 1;
    } else {
      let coreReachCount = 0;
      for (const file of repoFiles) {
        coreReachCount += findCoreReaches(readFileSync(file, "utf8"), dirname(file)).length;
      }
      if (coreReachCount < CORE_REACH_FLOOR) {
        console.error(`FAIL: core-reach floor ${CORE_REACH_FLOOR} not met; found ${coreReachCount}`);
        failures += 1;
      } else {
        console.log(`  anti-vacuity: ${repoFiles.length} repo files, ${coreReachCount} specifiers aimed into build/core (floors ${REPO_SCAN_FLOOR}/${CORE_REACH_FLOOR})`);
      }
    }
  }
  const patternChecks =
    bad.length +
    good.length +
    unresolvedBad.length +
    unresolvedGood.length +
    ticketsBad.length +
    ticketsGood.length +
    1;
  if (failures) {
    console.error(`self-test FAILED: ${failures} failing check(s)`);
    process.exit(1);
  }
  console.log(`PASS: build-core-surface self-test, ${patternChecks} pattern checks + anti-vacuity, all directions bite.`);
  process.exit(0);
}

if (SELF_TEST) selfTest();
else main();
