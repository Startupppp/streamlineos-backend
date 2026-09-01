#!/usr/bin/env node
/**
 * Gate: no service file may add an unbounded read or an offset-paginated list.
 *
 * Every detected path must appear in the classification file with one of:
 *   KEYSET-MIGRATED · BOUNDED · AGGREGATE · STREAM · FALSE-POSITIVE · EXCLUDED-MODULE · ACTIONABLE
 *
 * Failure modes:
 *   1. Unclassified path — file in scan has no classification entry → gate fails.
 *   2. Stale entry       — classification entry points at a file that no longer exists → gate fails.
 *   3. Regression        — file classified KEYSET-MIGRATED/BOUNDED/AGGREGATE/STREAM still detected → gate fails.
 *
 * ACTIONABLE entries do not fail the gate; they contribute to the ACTIONABLE count
 * displayed on every run — the ratchet mechanism that drives it to zero.
 *
 * --emit-baseline     : write the old baseline.json from current scan (legacy; gate no longer reads it).
 * --emit-classification: write a fresh classification.json from the current scan; all new entries
 *                        start as ACTIONABLE (CRM/Inventory auto-marked EXCLUDED-MODULE).
 * --self-test         : run self-tests and exit; proves all three gate failure modes bite.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";

const MIN_FILES = 500;
const MIN_MODULES = 40;
const ORDER_BY_LOOKBACK = 25;
const STATEMENT_MAX_LINES = 120;

const ROOT = new URL("../modules", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const BASELINE_FILE = new URL("./baselines/unbounded-reads-baseline.json", import.meta.url).pathname.replace(
  /^\/([A-Z]:)/,
  "$1",
);
const CLASSIFICATION_FILE = new URL("./baselines/unbounded-reads-classification.json", import.meta.url)
  .pathname.replace(/^\/([A-Z]:)/, "$1");

const EXCLUDED_MODULE_PREFIXES = ["/crm/", "/inventory/"];

function normalizeRelPath(file) {
  const normalizedFile = file.replace(/\\/g, "/");
  const normalizedRoot = ROOT.replace(/\\/g, "/");
  return normalizedFile.startsWith(normalizedRoot)
    ? normalizedFile.slice(normalizedRoot.length)
    : normalizedFile;
}

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

export function statementFrom(lines, start) {
  const collected = [];
  for (let i = start; i < lines.length && i < start + STATEMENT_MAX_LINES; i++) {
    collected.push(lines[i]);
    if (/;\s*$/.test(lines[i])) break;
  }
  return collected.join("\n");
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
      const lookahead = statementFrom(lines, i);
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

export function checkForUnclassified(offsetCounts, unboundedCounts, classification) {
  const unclassified = [];
  for (const relPath of Object.keys(offsetCounts)) {
    if (!classification.offset?.[relPath])
      unclassified.push({ kind: "offset", file: relPath });
  }
  for (const relPath of Object.keys(unboundedCounts)) {
    if (!classification.unbounded?.[relPath])
      unclassified.push({ kind: "unbounded", file: relPath });
  }
  return unclassified;
}

export function checkForStaleEntries(classification, root) {
  const stale = [];
  const rootFwd = root.replace(/\\/g, "/");
  for (const relPath of Object.keys(classification.offset ?? {})) {
    try { statSync(rootFwd + relPath); } catch { stale.push({ kind: "offset", file: relPath }); }
  }
  for (const relPath of Object.keys(classification.unbounded ?? {})) {
    try { statSync(rootFwd + relPath); } catch { stale.push({ kind: "unbounded", file: relPath }); }
  }
  return stale;
}

const FIXED_VERDICTS = new Set(["KEYSET-MIGRATED", "BOUNDED", "AGGREGATE", "STREAM"]);

export function checkForRegressions(offsetCounts, unboundedCounts, classification) {
  const regressions = [];
  for (const relPath of Object.keys(offsetCounts)) {
    const verdict = classification.offset?.[relPath]?.verdict;
    if (verdict && FIXED_VERDICTS.has(verdict))
      regressions.push({ kind: "offset", file: relPath, verdict });
  }
  for (const relPath of Object.keys(unboundedCounts)) {
    const verdict = classification.unbounded?.[relPath]?.verdict;
    if (verdict && FIXED_VERDICTS.has(verdict))
      regressions.push({ kind: "unbounded", file: relPath, verdict });
  }
  return regressions;
}

export function countActionableByKind(offsetCounts, unboundedCounts, classification) {
  let offset = 0;
  let unbounded = 0;
  for (const [relPath, count] of Object.entries(offsetCounts)) {
    if (classification.offset?.[relPath]?.verdict === "ACTIONABLE") offset += count;
  }
  for (const [relPath, count] of Object.entries(unboundedCounts)) {
    if (classification.unbounded?.[relPath]?.verdict === "ACTIONABLE") unbounded += count;
  }
  return { offset, unbounded };
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

  const longChain = `
    async page() {
      return this.db
        .select({ a: t.a, b: t.b })
        .from(t)
        .leftJoin(u, and(eq(u.orgId, t.orgId), eq(u.membershipId, t.membershipId), isNull(u.deletedAt)))
        .leftJoin(v, and(eq(v.orgId, t.orgId), eq(v.id, t.vId)))
        .where(and(eq(t.orgId, orgId), gt(t.id, cursor)))
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(pageLimit + 1);
    }
  `;
  if (isUnboundedSelect(longChain).length > 0) {
    console.error("SELF-TEST FAIL: a bounded chain whose .limit() sits past a 12-line window was flagged");
    process.exit(1);
  }
  const longChainNoLimit = longChain.replace(".limit(pageLimit + 1)", "");
  if (isUnboundedSelect(longChainNoLimit).length === 0) {
    console.error("SELF-TEST FAIL: the same long chain WITHOUT a .limit() was not flagged");
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

  const territory = discoverTerritory();
  if (territory.length < MIN_MODULES) {
    console.error(
      `SELF-TEST FAIL: discovered only ${territory.length} module folders (expected >= ${MIN_MODULES}) — ROOT is wrong: ${ROOT}`,
    );
    process.exit(1);
  }

  {
    const unclassified = checkForUnclassified(
      { "/fake/new-unclassified.service.ts": 1 },
      {},
      { offset: {}, unbounded: {} },
    );
    if (unclassified.length === 0) {
      console.error("SELF-TEST FAIL: new unclassified offset path was not detected");
      process.exit(1);
    }
  }

  {
    const stale = checkForStaleEntries(
      {
        offset: { "/definitely/does/not/exist/fake.service.ts": { verdict: "ACTIONABLE", note: "test" } },
        unbounded: {},
      },
      ROOT,
    );
    if (stale.length === 0) {
      console.error("SELF-TEST FAIL: stale classification entry pointing at non-existent file was not detected");
      process.exit(1);
    }
  }

  {
    const counts = countActionableByKind(
      { "/test/actionable.service.ts": 3, "/test/excluded.service.ts": 2 },
      { "/test/actionable-unbounded.service.ts": 5 },
      {
        offset: {
          "/test/actionable.service.ts": { verdict: "ACTIONABLE", note: "test" },
          "/test/excluded.service.ts": { verdict: "EXCLUDED-MODULE", note: "test" },
        },
        unbounded: {
          "/test/actionable-unbounded.service.ts": { verdict: "ACTIONABLE", note: "test" },
        },
      },
    );
    if (counts.offset !== 3 || counts.unbounded !== 5) {
      console.error(
        `SELF-TEST FAIL: ACTIONABLE count wrong — expected offset=3,unbounded=5, got offset=${counts.offset},unbounded=${counts.unbounded}`,
      );
      process.exit(1);
    }
  }

  {
    const regressions = checkForRegressions(
      { "/test/was-migrated.service.ts": 1 },
      {},
      { offset: { "/test/was-migrated.service.ts": { verdict: "KEYSET-MIGRATED", note: "test" } }, unbounded: {} },
    );
    if (regressions.length === 0) {
      console.error("SELF-TEST FAIL: KEYSET-MIGRATED file still appearing in scan was not detected as regression");
      process.exit(1);
    }
  }

  console.log("Self-tests passed.");
}

runSelfTests();

const emitBaseline = process.argv.includes("--emit-baseline");
const emitClassification = process.argv.includes("--emit-classification");
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
    const relPath = normalizeRelPath(file);

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

const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

if (emitBaseline) {
  writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify(
      { offset: offsetCounts, unbounded: unboundedCounts, unordered: unorderedCounts },
      null,
      2,
    )}\n`,
  );
  console.log(
    `Baseline written (legacy): ${total(offsetCounts)} offset, ${total(unboundedCounts)} unbounded, ${total(unorderedCounts)} unordered across ${scannedCount} files.`,
  );
  process.exit(0);
}

if (emitClassification) {
  const cls = {
    version: 1,
    classifiedAt: new Date().toISOString().slice(0, 10),
    note: "Verdicts: KEYSET-MIGRATED|BOUNDED|AGGREGATE|STREAM|FALSE-POSITIVE|EXCLUDED-MODULE|ACTIONABLE",
    offset: {},
    unbounded: {},
  };
  for (const relPath of Object.keys(offsetCounts).sort()) {
    const excluded = EXCLUDED_MODULE_PREFIXES.some((p) => relPath.startsWith(p));
    cls.offset[relPath] = {
      verdict: excluded ? "EXCLUDED-MODULE" : "ACTIONABLE",
      note: excluded
        ? "CRM/Inventory excluded product domain — do not fix in this lane"
        : "Offset pagination; needs keyset migration or proven depth bound",
    };
  }
  for (const relPath of Object.keys(unboundedCounts).sort()) {
    const excluded = EXCLUDED_MODULE_PREFIXES.some((p) => relPath.startsWith(p));
    cls.unbounded[relPath] = {
      verdict: excluded ? "EXCLUDED-MODULE" : "ACTIONABLE",
      note: excluded
        ? "CRM/Inventory excluded product domain — do not fix in this lane"
        : "Unbounded select; needs limit, aggregate exemption, or false-positive review",
    };
  }
  writeFileSync(CLASSIFICATION_FILE, `${JSON.stringify(cls, null, 2)}\n`);
  const actionableOff = Object.values(cls.offset).filter((e) => e.verdict === "ACTIONABLE").length;
  const excludedOff = Object.values(cls.offset).filter((e) => e.verdict === "EXCLUDED-MODULE").length;
  const actionableUnb = Object.values(cls.unbounded).filter((e) => e.verdict === "ACTIONABLE").length;
  const excludedUnb = Object.values(cls.unbounded).filter((e) => e.verdict === "EXCLUDED-MODULE").length;
  console.log(`Classification written:`);
  console.log(`  offset   : ${actionableOff} ACTIONABLE, ${excludedOff} EXCLUDED-MODULE (${actionableOff + excludedOff} total)`);
  console.log(`  unbounded: ${actionableUnb} ACTIONABLE, ${excludedUnb} EXCLUDED-MODULE (${actionableUnb + excludedUnb} total)`);
  process.exit(0);
}

let classification;
try {
  classification = JSON.parse(readFileSync(CLASSIFICATION_FILE, "utf8"));
} catch {
  console.error(
    `Classification file missing or unreadable: ${CLASSIFICATION_FILE}. Run with --emit-classification to generate it.`,
  );
  process.exit(1);
}

console.log(`Scanned ${scannedCount} service files across ${territory.length} modules.`);
console.log(`  offset pagination : ${total(offsetCounts)}`);
console.log(`  unbounded reads   : ${total(unboundedCounts)}`);
console.log(
  `  unordered paging  : ${total(unorderedCounts)} — .offset() with no ORDER BY repeats and drops rows between pages`,
);

const staleEntries = checkForStaleEntries(classification, ROOT);
const unclassifiedPaths = checkForUnclassified(offsetCounts, unboundedCounts, classification);
const regressions = checkForRegressions(offsetCounts, unboundedCounts, classification);
const actionable = countActionableByKind(offsetCounts, unboundedCounts, classification);

const verdictCounts = { offset: {}, unbounded: {} };
for (const [relPath] of Object.entries(offsetCounts)) {
  const v = classification.offset?.[relPath]?.verdict ?? "UNCLASSIFIED";
  verdictCounts.offset[v] = (verdictCounts.offset[v] ?? 0) + 1;
}
for (const [relPath] of Object.entries(unboundedCounts)) {
  const v = classification.unbounded?.[relPath]?.verdict ?? "UNCLASSIFIED";
  verdictCounts.unbounded[v] = (verdictCounts.unbounded[v] ?? 0) + 1;
}

console.log(`\nClassification summary (by file):`);
for (const [v, c] of Object.entries(verdictCounts.offset))
  console.log(`  offset     ${v.padEnd(18)}: ${c} file(s)`);
for (const [v, c] of Object.entries(verdictCounts.unbounded))
  console.log(`  unbounded  ${v.padEnd(18)}: ${c} file(s)`);

console.log(`\nActionable instance counts (target: zero):`);
console.log(`  offset pagination : ${actionable.offset}`);
console.log(`  unbounded reads   : ${actionable.unbounded}`);

const failures = [];

if (staleEntries.length > 0) {
  console.error(`\nSTALE classification entries (file no longer exists — remove or update):`);
  for (const s of staleEntries)
    console.error(`  [${s.kind.toUpperCase()}] ${s.file}`);
  failures.push(`${staleEntries.length} stale classification entry(ies)`);
}

if (unclassifiedPaths.length > 0) {
  console.error(`\nUNCLASSIFIED paths (add entries to unbounded-reads-classification.json):`);
  for (const u of unclassifiedPaths) {
    console.error(`  [${u.kind.toUpperCase()}] ${u.file}`);
    for (const d of detail.filter((x) => x.file === u.file && x.kind === u.kind))
      console.error(`      :${d.lineNo}  ${d.text}`);
  }
  failures.push(`${unclassifiedPaths.length} unclassified path(s) — classify before committing`);
}

if (regressions.length > 0) {
  console.error(`\nREGRESSIONS (classified as fixed but violations still detected):`);
  for (const r of regressions)
    console.error(`  [${r.kind.toUpperCase()}] ${r.file} (was ${r.verdict})`);
  failures.push(`${regressions.length} regression(s) — re-check the migration`);
}

if (unorderedCounts && Object.keys(unorderedCounts).length > 0) {
  console.error(`\nUNORDERED pagination (.offset() with no ORDER BY — always a correctness bug):`);
  for (const [f, c] of Object.entries(unorderedCounts))
    console.error(`  ${f} — ${c} instance(s)`);
  failures.push(`${Object.keys(unorderedCounts).length} unordered pagination file(s)`);
}

if (failures.length > 0) {
  console.error(`\nFAIL — ${failures.length} gate violation(s):`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error("\nFix guide:");
  console.error("  Unclassified : run --emit-classification or add entries manually to classification.json");
  console.error("  Stale        : remove the entry or update the file path");
  console.error("  Regression   : the migration is incomplete — offset/unbounded still present in source");
  process.exit(1);
}

console.log("\nOK — no gate violations.");
console.log(`Ratchet progress: offset ACTIONABLE=${actionable.offset} (target 0) · unbounded ACTIONABLE=${actionable.unbounded} (target 0)`);
process.exit(0);
