#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(HERE, "..", "..");
const BUILD_ROOT = join(BACKEND_ROOT, "src", "modules", "build");
const CORE_ROOT = resolve(BUILD_ROOT, "core");
const SELF_TEST = process.argv.includes("--self-test");

const SCAN_FLOOR = 20;

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
  console.log(`OK — ${siblings.length} sibling submodule file(s) scanned; 0 deep core imports.`);
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
  }
  if (failures) {
    console.error(`self-test FAILED: ${failures} failing check(s)`);
    process.exit(1);
  }
  console.log(`PASS: build-core-surface self-test, ${bad.length + good.length} pattern checks + anti-vacuity, all directions bite.`);
  process.exit(0);
}

if (SELF_TEST) selfTest();
else main();
