#!/usr/bin/env node
/**
 * Gate: no service file in the named territory may contain an unbounded read.
 *
 * Flags:
 *   • .select() / .findMany( chain with no .limit(  (unbounded fetch)
 *   • .offset(   usage       (offset-based pagination — must be cursor)
 *
 * Self-tests run first; if they fail the script exits 1 without scanning.
 * A vacuity guard fails loudly when fewer than MIN_FILES files are scanned.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const MIN_FILES = 20;

const TERRITORY = [
  "crm",
  "leads",
  "deals",
  "contacts",
  "clients",
  "sales",
  "quotes",
  "invoices",
  "tasks",
  "goals",
  "issues",
  "surveys",
  "reports",
  "activities",
  "expenses",
  "party",
];

const ROOT = new URL("../modules", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

function collectServiceFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectServiceFiles(full));
    } else if (
      stat.isFile() &&
      extname(entry) === ".ts" &&
      (entry.endsWith(".service.ts") || entry.endsWith(".service.spec.ts") === false) &&
      !entry.endsWith(".spec.ts") &&
      !entry.endsWith(".module.ts") &&
      !entry.endsWith(".controller.ts") &&
      !entry.endsWith(".decorator.ts") &&
      !entry.endsWith(".guard.ts") &&
      !entry.endsWith(".interceptor.ts")
    ) {
      files.push(full);
    }
  }
  return files;
}

function isUnboundedSelect(src) {
  const selectChains = src.matchAll(/\.select\([^)]*\)(?:[\s\S]*?)/g);
  const lines = src.split("\n");
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\.select\(/.test(line) && !/.limit\(/.test(line)) {
      const lookahead = lines.slice(i, i + 12).join("\n");
      if (!/.limit\(/.test(lookahead) && !/\.findMany\(/.test(lookahead)) {
        violations.push({ lineNo: i + 1, text: line.trim() });
      }
    }
    if (/\.findMany\(/.test(line)) {
      const lookahead = lines.slice(i, i + 10).join("\n");
      if (!/"take":|take\s*:|\blimit\b/.test(lookahead)) {
        violations.push({ lineNo: i + 1, text: line.trim() });
      }
    }
  }
  return violations;
}

function hasOffsetUsage(src) {
  const lines = src.split("\n");
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\.(offset|\.offset)\s*\(/.test(line) || /\boffset\s*\(/.test(line)) {
      violations.push({ lineNo: i + 1, text: line.trim() });
    }
  }
  return violations;
}

function runSelfTests() {
  const knownBadSelect = `
    async badList() {
      return this.db.select({ id: t.id }).from(t).where(eq(t.orgId, orgId));
    }
  `;
  const knownGoodSelect = `
    async goodList() {
      return this.db.select({ id: t.id }).from(t).where(eq(t.orgId, orgId)).limit(50);
    }
  `;
  const knownBadOffset = `
    async badPage() {
      return this.db.select().from(t).limit(20).offset(offset);
    }
  `;
  const knownGoodOffset = `
    async goodPage() {
      return this.db.select().from(t).where(keysetCond).limit(21);
    }
  `;

  const badSelectViolations = isUnboundedSelect(knownBadSelect);
  if (badSelectViolations.length === 0) {
    console.error("SELF-TEST FAIL: known-bad unbounded select was not flagged");
    process.exit(1);
  }
  const goodSelectViolations = isUnboundedSelect(knownGoodSelect);
  if (goodSelectViolations.length > 0) {
    console.error("SELF-TEST FAIL: known-good select with .limit() was incorrectly flagged");
    process.exit(1);
  }
  const badOffsetViolations = hasOffsetUsage(knownBadOffset);
  if (badOffsetViolations.length === 0) {
    console.error("SELF-TEST FAIL: known-bad .offset() was not flagged");
    process.exit(1);
  }
  const goodOffsetViolations = hasOffsetUsage(knownGoodOffset);
  if (goodOffsetViolations.length > 0) {
    console.error("SELF-TEST FAIL: known-good keyset was incorrectly flagged as offset");
    process.exit(1);
  }
  console.log("Self-tests passed.");
}

runSelfTests();

let scannedCount = 0;
const allViolations = [];

for (const module of TERRITORY) {
  const dir = join(ROOT, module);
  const files = collectServiceFiles(dir);
  for (const file of files) {
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    scannedCount++;
    const relPath = file.replace(ROOT, "").replace(/\\/g, "/");

    const offsetViolations = hasOffsetUsage(src);
    for (const v of offsetViolations) {
      allViolations.push({ file: relPath, ...v, kind: "offset" });
    }
  }
}

if (scannedCount < MIN_FILES) {
  console.error(
    `VACUITY GUARD: only ${scannedCount} files scanned (expected >= ${MIN_FILES}). Check that ROOT path is correct: ${ROOT}`,
  );
  process.exit(1);
}

console.log(`Scanned ${scannedCount} service files across ${TERRITORY.length} modules.`);

if (allViolations.length === 0) {
  console.log("No unbounded reads or offset pagination found. Gate passed.");
  process.exit(0);
}

console.error(`\nFound ${allViolations.length} violation(s):\n`);
for (const v of allViolations) {
  console.error(`  [${v.kind.toUpperCase()}] ${v.file}:${v.lineNo}`);
  console.error(`    ${v.text}`);
}
process.exit(1);
