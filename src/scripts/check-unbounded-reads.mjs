#!/usr/bin/env node
/**
 * Gate: no service file may add an unbounded read or an offset-paginated list.
 *
 * Flags:
 *   • .select() / .findMany( chain with no .limit(  (unbounded fetch)
 *   • .offset(   usage       (offset-based pagination — must be cursor)
 *
 * Territory is EVERY folder under src/modules, discovered at run time. It was
 * previously a hand-written list of 16 CRM folders, so 58 modules were never
 * scanned and the gate reported "no unbounded reads found" for code it had not
 * read. A hand-written list cannot be kept in step with a new module.
 *
 * Existing violations are ratcheted per file in BASELINE_FILE rather than
 * silently tolerated: a new file, or a higher count in a known file, fails.
 * Lowering a count is the migration path — run --emit-baseline and commit.
 *
 * Self-tests run first; if they fail the script exits 1 without scanning.
 * A vacuity guard fails loudly when fewer than MIN_FILES files are scanned.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";

const MIN_FILES = 500;
const MIN_MODULES = 40;
const ORDER_BY_LOOKBACK = 25;

const ROOT = new URL("../modules", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const BASELINE_FILE = new URL("./baselines/unbounded-reads-baseline.json", import.meta.url).pathname.replace(
  /^\/([A-Z]:)/,
  "$1",
);

function discoverTerritory() {
  return readdirSync(ROOT)
    .filter((entry) => {
      try {
        return statSync(join(ROOT, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

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

export function projectsOnlyAggregates(chain) {
  const start = chain.indexOf(".select(");
  if (start === -1) return false;
  const fromAt = chain.indexOf(".from(", start);
  const projection = chain.slice(start, fromAt === -1 ? chain.length : fromAt);
  return /\b(count|sum|avg|min|max)\s*\(/i.test(projection);
}

function isUnboundedSelect(src) {
  const lines = src.split("\n");
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\.select\(/.test(line) && !/.limit\(/.test(line)) {
      const lookahead = lines.slice(i, i + 12).join("\n");
      if (
        !/.limit\(/.test(lookahead) &&
        !/\.findMany\(/.test(lookahead) &&
        !projectsOnlyAggregates(lookahead)
      ) {
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

function hasUnorderedPagination(src) {
  const lines = src.split("\n");
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\.offset\s*\(/.test(lines[i])) continue;
    const chain = lines.slice(Math.max(0, i - ORDER_BY_LOOKBACK), i + 2).join("\n");
    if (!/\.orderBy\s*\(/.test(chain))
      violations.push({ lineNo: i + 1, text: lines[i].trim() });
  }
  return violations;
}

function compareToBaseline(counts, baseline) {
  const regressions = [];
  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) regressions.push({ file, count, allowed });
  }
  const improvements = [];
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = counts[file] ?? 0;
    if (count < allowed) improvements.push({ file, count, allowed });
  }
  return { regressions, improvements };
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

  if (isUnboundedSelect(knownBadSelect).length === 0) {
    console.error("SELF-TEST FAIL: known-bad unbounded select was not flagged");
    process.exit(1);
  }
  if (isUnboundedSelect(knownGoodSelect).length > 0) {
    console.error("SELF-TEST FAIL: known-good select with .limit() was incorrectly flagged");
    process.exit(1);
  }
  if (hasOffsetUsage(knownBadOffset).length === 0) {
    console.error("SELF-TEST FAIL: known-bad .offset() was not flagged");
    process.exit(1);
  }
  if (hasOffsetUsage(knownGoodOffset).length > 0) {
    console.error("SELF-TEST FAIL: known-good keyset was incorrectly flagged as offset");
    process.exit(1);
  }

  const aggregateOnly = `
    async total() {
      return this.db.select({ count: count() }).from(t).where(eq(t.orgId, orgId));
    }
  `;
  if (isUnboundedSelect(aggregateOnly).length > 0) {
    console.error("SELF-TEST FAIL: an aggregate-only projection was flagged as an unbounded read");
    process.exit(1);
  }
  const rawSqlAggregate = `
    async totals() {
      return this.db
        .select({ total: sql\`COUNT(*)::int\` })
        .from(t)
        .where(and(...f));
    }
  `;
  if (isUnboundedSelect(rawSqlAggregate).length > 0) {
    console.error("SELF-TEST FAIL: an uppercase raw-SQL COUNT(*) projection was flagged as unbounded");
    process.exit(1);
  }

  const rowsNotAggregates = `
    async everyRow() {
      return this.db.select({ id: t.id, name: t.name }).from(t).where(eq(t.orgId, orgId));
    }
  `;
  if (isUnboundedSelect(rowsNotAggregates).length === 0) {
    console.error("SELF-TEST FAIL: a row-returning select with no .limit() was not flagged");
    process.exit(1);
  }

  const unorderedBad = `
    async badPage() {
      return this.db.select().from(t).where(conditions).limit(20).offset(offset);
    }
  `;
  const unorderedGood = `
    async goodPage() {
      return this.db
        .select()
        .from(t)
        .where(conditions)
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(20)
        .offset(offset);
    }
  `;
  if (hasUnorderedPagination(unorderedBad).length === 0) {
    console.error("SELF-TEST FAIL: .offset() with no ORDER BY was not flagged");
    process.exit(1);
  }
  if (hasUnorderedPagination(unorderedGood).length > 0) {
    console.error("SELF-TEST FAIL: an ordered offset page was incorrectly flagged");
    process.exit(1);
  }

  const baseline = { "/a/x.service.ts": 2 };
  const unchanged = compareToBaseline({ "/a/x.service.ts": 2 }, baseline);
  if (unchanged.regressions.length !== 0) {
    console.error("SELF-TEST FAIL: a file at its baseline count was reported as a regression");
    process.exit(1);
  }
  const grown = compareToBaseline({ "/a/x.service.ts": 3 }, baseline);
  if (grown.regressions.length !== 1) {
    console.error("SELF-TEST FAIL: a file above its baseline count was not reported");
    process.exit(1);
  }
  const movedNotAdded = compareToBaseline({ "/a/x.service.ts": 1, "/a/new.service.ts": 1 }, baseline);
  if (movedNotAdded.regressions.length !== 1 || movedNotAdded.regressions[0].file !== "/a/new.service.ts") {
    console.error(
      "SELF-TEST FAIL: a NEW offending file was not reported when the repo-wide total stayed the same",
    );
    process.exit(1);
  }
  const shrunk = compareToBaseline({ "/a/x.service.ts": 0 }, baseline);
  if (shrunk.regressions.length !== 0 || shrunk.improvements.length !== 1) {
    console.error("SELF-TEST FAIL: a fixed file was not reported as an improvement");
    process.exit(1);
  }

  const territory = discoverTerritory();
  if (territory.length < MIN_MODULES) {
    console.error(
      `SELF-TEST FAIL: discovered only ${territory.length} module folders (expected >= ${MIN_MODULES}) — ROOT is wrong: ${ROOT}`,
    );
    process.exit(1);
  }

  console.log("Self-tests passed.");
}

runSelfTests();

const emitBaseline = process.argv.includes("--emit-baseline");
if (process.argv.includes("--self-test")) process.exit(0);

const territory = discoverTerritory();
let scannedCount = 0;
const offsetCounts = {};
const unboundedCounts = {};
const unorderedCounts = {};
const detail = [];

for (const module of territory) {
  for (const file of collectServiceFiles(join(ROOT, module))) {
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    scannedCount++;
    const relPath = file.replace(ROOT, "").replace(/\\/g, "/");

    const offsets = hasOffsetUsage(src);
    if (offsets.length > 0) {
      offsetCounts[relPath] = offsets.length;
      for (const v of offsets) detail.push({ file: relPath, ...v, kind: "offset" });
    }
    const unbounded = isUnboundedSelect(src);
    if (unbounded.length > 0) {
      unboundedCounts[relPath] = unbounded.length;
      for (const v of unbounded) detail.push({ file: relPath, ...v, kind: "unbounded" });
    }
    const unordered = hasUnorderedPagination(src);
    if (unordered.length > 0) {
      unorderedCounts[relPath] = unordered.length;
      for (const v of unordered) detail.push({ file: relPath, ...v, kind: "unordered" });
    }
  }
}

if (scannedCount < MIN_FILES) {
  console.error(
    `VACUITY GUARD: only ${scannedCount} files scanned (expected >= ${MIN_FILES}). Check ROOT: ${ROOT}`,
  );
  process.exit(1);
}

if (emitBaseline) {
  writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify(
      { offset: offsetCounts, unbounded: unboundedCounts, unordered: unorderedCounts },
      null,
      2,
    )}\n`,
  );
  const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(
    `Baseline written: ${total(offsetCounts)} offset, ${total(unboundedCounts)} unbounded, ${total(unorderedCounts)} unordered across ${scannedCount} files.`,
  );
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
} catch {
  console.error(`Baseline file missing or unreadable: ${BASELINE_FILE}. Run with --emit-baseline.`);
  process.exit(1);
}

const offsetResult = compareToBaseline(offsetCounts, baseline.offset ?? {});
const unboundedResult = compareToBaseline(unboundedCounts, baseline.unbounded ?? {});
const unorderedResult = compareToBaseline(unorderedCounts, baseline.unordered ?? {});

const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

console.log(`Scanned ${scannedCount} service files across ${territory.length} modules.`);
console.log(`  offset pagination : ${total(offsetCounts)} (baseline ${total(baseline.offset ?? {})})`);
console.log(`  unbounded reads   : ${total(unboundedCounts)} (baseline ${total(baseline.unbounded ?? {})})`);
console.log(
  `  unordered paging  : ${total(unorderedCounts)} (baseline ${total(baseline.unordered ?? {})}) — .offset() with no ORDER BY repeats and drops rows between pages`,
);

const regressions = [
  ...offsetResult.regressions.map((r) => ({ ...r, kind: "offset" })),
  ...unboundedResult.regressions.map((r) => ({ ...r, kind: "unbounded" })),
  ...unorderedResult.regressions.map((r) => ({ ...r, kind: "unordered" })),
];

if (regressions.length > 0) {
  console.error(`\nFAIL — ${regressions.length} file(s) above baseline:\n`);
  for (const r of regressions) {
    console.error(`  [${r.kind.toUpperCase()}] ${r.file} — ${r.count} (allowed ${r.allowed})`);
    for (const d of detail.filter((x) => x.file === r.file && x.kind === r.kind)) {
      console.error(`      :${d.lineNo}  ${d.text}`);
    }
  }
  console.error(
    "\nUse the shared cursor contract in src/common/pagination/keyset.ts. Offset pagination and unbounded reads may not grow.",
  );
  process.exit(1);
}

const improvements = [
  ...offsetResult.improvements,
  ...unboundedResult.improvements,
  ...unorderedResult.improvements,
];
if (improvements.length > 0) {
  console.log(`\n${improvements.length} file(s) improved below baseline — run --emit-baseline and commit to lock it in:`);
  for (const i of improvements) console.log(`  ${i.file} — ${i.count} (baseline ${i.allowed})`);
}

console.log("\nOK — no new unbounded reads or offset pagination.");
process.exit(0);
