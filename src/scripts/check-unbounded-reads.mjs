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

const MIN_FILES = 2700;
const MIN_MODULES = 40;
const MIN_COMMON_FILES = 150;
const MIN_DB_FILES = 300;

/**
 * Ceiling on unbounded reads suppressed by a FALSE-POSITIVE verdict — INSTANCES,
 * not files. See countSuppressed() for why the file count could not catch this.
 * Measured at 651 on 2026-09-03 over all three scan roots and set with no headroom; lowered to
 * 648 on 2026-09-04 when /surveys/survey-live-participant.service.ts moved from FALSE-POSITIVE to
 * BOUNDED and stopped suppressing its three reads (PRD-C058); lowered again to 647 the same day when
 * /hr/recruitment/recruitment-candidate-ops.service.ts moved the same way — its bulkImport dedupe
 * probe now reads the request's emails instead of the whole organisation (PRD-C119); lowered again to
 * 646 on 2026-09-04 when /build/core/projects-search.service.ts stopped materialising the caller's
 * whole `project_members` list into an `inArray` and became a correlated EXISTS, so its suppression
 * row was deleted rather than reworded (PRD-C123). Lowering it is
 * the ratchet working:
 * a new read hiding behind an existing justification must fail here, because that
 * is the only place it can fail. Lower it when you bound one; raising it means
 * saying, in ratchets.json, which read is now hidden and why.
 */
const MAX_SUPPRESSED_UNBOUNDED = 646;
const ORDER_BY_LOOKBACK = 25;
const STATEMENT_MAX_LINES = 120;

const ROOT = new URL("../modules", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const COMMON_ROOT = new URL("../common", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const DB_ROOT = new URL("../db", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

/**
 * The gate reads THREE trees, not one.
 *
 * It read `src/modules` alone until 2026-09-03, and reported "2,301 files scanned,
 * 3 actionable" over a repository where `src/common` (188 non-spec files, the whole
 * asynchronous substrate — tenant enumeration, outbox, workflow, cache) and `src/db`
 * (364 files) were outside the corpus entirely. The single widest unbounded read in
 * the repository lived in the blind spot: `common/tenant/for-each-org.ts:158` selects
 * every ACTIVE organisation with no LIMIT and is called from 84 sites. A green run
 * was evidence about `src/modules` and was read as evidence about the system, which
 * is the exact failure `gate-corpus.mjs` documents.
 *
 * `key` is the classification-file prefix. `src/modules` keeps the bare
 * `/<module>/<path>` form so the 365 existing entries are untouched; the new roots
 * carry an `@`-prefixed name, which cannot collide with a module folder (both trees
 * contain an `hr` folder and an `org`-prefixed one, so an unprefixed union WOULD
 * have merged two different files onto one key).
 *
 * `minFiles` is per root and is the point: an aggregate floor cannot tell "one root
 * silently resolved to nothing" from "the repository shrank", and a root that
 * resolves to nothing is how this gate went blind in the first place.
 */
const SCAN_ROOTS = [
  { key: "", dir: ROOT, minFiles: 1800, label: "src/modules" },
  { key: "@common", dir: COMMON_ROOT, minFiles: MIN_COMMON_FILES, label: "src/common" },
  { key: "@db", dir: DB_ROOT, minFiles: MIN_DB_FILES, label: "src/db" },
];

/** Resolve a classification key back to the file it names, across every root. */
export function resolveClassifiedPath(relPath, roots = SCAN_ROOTS) {
  for (const root of roots) {
    if (root.key === "") continue;
    if (relPath.startsWith(`${root.key}/`))
      return root.dir.replace(/\\/g, "/") + relPath.slice(root.key.length);
  }
  return ROOT.replace(/\\/g, "/") + relPath;
}
const BASELINE_FILE = new URL("./baselines/unbounded-reads-baseline.json", import.meta.url).pathname.replace(
  /^\/([A-Z]:)/,
  "$1",
);
const CLASSIFICATION_FILE = new URL("./baselines/unbounded-reads-classification.json", import.meta.url)
  .pathname.replace(/^\/([A-Z]:)/, "$1");

const EXCLUDED_MODULE_PREFIXES = ["/crm/", "/inventory/"];

function normalizeRelPath(file, root = SCAN_ROOTS[0]) {
  const normalizedFile = file.replace(/\\/g, "/");
  const normalizedRoot = root.dir.replace(/\\/g, "/");
  return normalizedFile.startsWith(normalizedRoot)
    ? root.key + normalizedFile.slice(normalizedRoot.length)
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
      const lookahead = statementFrom(lines, i);
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

export function checkForStaleEntries(classification, resolve = resolveClassifiedPath) {
  const stale = [];
  for (const relPath of Object.keys(classification.offset ?? {})) {
    try { statSync(resolve(relPath)); } catch { stale.push({ kind: "offset", file: relPath }); }
  }
  for (const relPath of Object.keys(classification.unbounded ?? {})) {
    try { statSync(resolve(relPath)); } catch { stale.push({ kind: "unbounded", file: relPath }); }
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

/**
 * Reads that a FALSE-POSITIVE verdict is currently hiding, counted as INSTANCES
 * rather than files.
 *
 * The verdict is keyed per FILE and every entry carries one prose sentence, so a
 * sentence that is true of some reads in a file silently covers all of them. That
 * is not hypothetical: `/clients/clients.service.ts` was blessed with "client reads
 * bounded by clientId+orgId (single-record lookups)", which is true of its two
 * per-client reads and false of `exportCsv`, an unbounded select of every client
 * row in the org that the same entry made invisible. Nothing in the gate could see
 * that, because the file count does not move when a blessed file gains a read.
 *
 * This number does. It is printed on every run and ratcheted, so the next read that
 * hides behind an existing sentence fails the gate and names the file, and somebody
 * has to read the sentence again.
 */
export function countSuppressed(unboundedCounts, classification) {
  let suppressed = 0;
  for (const [relPath, count] of Object.entries(unboundedCounts)) {
    if (classification.unbounded?.[relPath]?.verdict === "FALSE-POSITIVE") suppressed += count;
  }
  return suppressed;
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

  const longBoundedFindMany = `
    async list() {
      return this.db.query.records.findMany({
        where: and(eq(records.orgId, orgId), eq(records.parentId, parentId)),
        columns: {
          id: true,
          name: true,
          createdAt: true,
        },
        with: {
          owner: { columns: { id: true, name: true } },
        },
        orderBy: [desc(records.createdAt), desc(records.id)],
        limit: 101,
      });
    }
  `;
  if (isUnboundedSelect(longBoundedFindMany).length > 0) {
    console.error("SELF-TEST FAIL: a findMany() bound later in its statement was flagged");
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
    const stale = checkForStaleEntries({
      offset: { "/definitely/does/not/exist/fake.service.ts": { verdict: "ACTIONABLE", note: "test" } },
      unbounded: {},
    });
    if (stale.length === 0) {
      console.error("SELF-TEST FAIL: stale classification entry pointing at non-existent file was not detected");
      process.exit(1);
    }
  }

  // The three roots, and the prefixes that keep them apart. Both src/modules and
  // src/common hold an `hr/` folder, so an unprefixed union would have silently
  // merged `/hr/x.ts` from two different trees into one classification entry.
  {
    for (const root of SCAN_ROOTS) {
      const found = collectServiceFiles(root.dir).length;
      if (found < root.minFiles) {
        console.error(
          `SELF-TEST FAIL: scan root ${root.label} yielded ${found} files (expected >= ${root.minFiles}) — it resolves to ${root.dir}`,
        );
        process.exit(1);
      }
    }
    const commonRoot = SCAN_ROOTS.find((r) => r.key === "@common");
    const sample = normalizeRelPath(join(commonRoot.dir, "tenant/for-each-org.ts"), commonRoot);
    if (sample !== "@common/tenant/for-each-org.ts") {
      console.error(`SELF-TEST FAIL: a src/common path normalised to "${sample}", not an @common key`);
      process.exit(1);
    }
    if (resolveClassifiedPath(sample) !== `${commonRoot.dir}/tenant/for-each-org.ts`) {
      console.error("SELF-TEST FAIL: an @common classification key does not resolve back to its file");
      process.exit(1);
    }
    const moduleKey = normalizeRelPath(join(ROOT, "hr/x.service.ts"), SCAN_ROOTS[0]);
    if (moduleKey !== "/hr/x.service.ts" || resolveClassifiedPath(moduleKey) !== `${ROOT}/hr/x.service.ts`) {
      console.error("SELF-TEST FAIL: a src/modules key no longer round-trips unprefixed");
      process.exit(1);
    }
    if (normalizeRelPath(join(commonRoot.dir, "hr/y.ts"), commonRoot) === moduleKey.replace("/x.service", "/y")) {
      console.error("SELF-TEST FAIL: src/common/hr and src/modules/hr collide on one classification key");
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

  // The suppression ceiling: a read ADDED to an already-FALSE-POSITIVE file must move
  // this number, because nothing else in the gate moves when that happens — the file
  // count is unchanged and the file is already classified, so there is no unclassified
  // path and no regression to report.
  {
    const cls = {
      offset: {},
      unbounded: {
        "/blessed/two-reads.service.ts": { verdict: "FALSE-POSITIVE", note: "test" },
        "/blessed/actionable.service.ts": { verdict: "ACTIONABLE", note: "test" },
        "/blessed/excluded.service.ts": { verdict: "EXCLUDED-MODULE", note: "test" },
      },
    };
    const before = countSuppressed(
      { "/blessed/two-reads.service.ts": 2, "/blessed/actionable.service.ts": 5, "/blessed/excluded.service.ts": 9 },
      cls,
    );
    const after = countSuppressed(
      { "/blessed/two-reads.service.ts": 3, "/blessed/actionable.service.ts": 5, "/blessed/excluded.service.ts": 9 },
      cls,
    );
    if (before !== 2) {
      console.error(`SELF-TEST FAIL: suppressed count should be 2 (FALSE-POSITIVE only), got ${before}`);
      process.exit(1);
    }
    if (after <= before) {
      console.error("SELF-TEST FAIL: a third read added to a FALSE-POSITIVE file did not raise the suppressed count");
      process.exit(1);
    }
    const unclassified = checkForUnclassified({}, { "/blessed/two-reads.service.ts": 3 }, cls);
    const regressed = checkForRegressions({}, { "/blessed/two-reads.service.ts": 3 }, cls);
    if (unclassified.length !== 0 || regressed.length !== 0) {
      console.error(
        "SELF-TEST FAIL: the fixture is wrong — a read added to a blessed file must be invisible to the unclassified and regression checks, which is why the ceiling exists",
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
const perRootCounts = [];
const offsetCounts = {};
const unboundedCounts = {};
const unorderedCounts = {};
const detail = [];

for (const root of SCAN_ROOTS) {
  let rootScanned = 0;
  for (const file of collectServiceFiles(root.dir)) {
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    scannedCount++;
    rootScanned++;
    const relPath = normalizeRelPath(file, root);

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
  perRootCounts.push({ ...root, scanned: rootScanned });
}

for (const root of perRootCounts) {
  if (root.scanned < root.minFiles) {
    console.error(
      `VACUITY GUARD: ${root.label} yielded only ${root.scanned} files (expected >= ${root.minFiles}). That root resolved to nothing or to the wrong tree: ${root.dir}`,
    );
    process.exit(1);
  }
}

if (scannedCount < MIN_FILES) {
  console.error(
    `VACUITY GUARD: only ${scannedCount} files scanned across ${SCAN_ROOTS.length} roots (expected >= ${MIN_FILES}).`,
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

// The corpus, named. "3 actionable" over 2,301 files read as a statement about the
// system for as long as nothing said which 2,301.
console.log(`Scanned ${scannedCount} service files across ${SCAN_ROOTS.length} roots:`);
for (const root of perRootCounts)
  console.log(
    `  ${root.label.padEnd(12)}: ${root.scanned} file(s)${root.key === "" ? ` across ${territory.length} modules` : ""}`,
  );
console.log(`  offset pagination : ${total(offsetCounts)}`);
console.log(`  unbounded reads   : ${total(unboundedCounts)}`);
console.log(
  `  unordered paging  : ${total(unorderedCounts)} — .offset() with no ORDER BY repeats and drops rows between pages`,
);

const staleEntries = checkForStaleEntries(classification);
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

const suppressed = countSuppressed(unboundedCounts, classification);
console.log(
  `\nSuppressed by a FALSE-POSITIVE justification: ${suppressed} unbounded read(s) [ceiling ${MAX_SUPPRESSED_UNBOUNDED}]`,
);

const failures = [];

if (suppressed > MAX_SUPPRESSED_UNBOUNDED) {
  console.error(
    `\nSUPPRESSION CEILING: ${suppressed} unbounded read(s) are hidden behind a FALSE-POSITIVE verdict, against a ceiling of ${MAX_SUPPRESSED_UNBOUNDED}.`,
  );
  console.error(
    "  A verdict is keyed per FILE and carries ONE sentence, so a read added to an already-blessed file\n" +
      "  inherits a justification that was never written about it. That is how an unbounded CSV export of\n" +
      "  every client in the org sat under 'client reads bounded by clientId+orgId (single-record lookups)'.\n" +
      "  Bound the new read, or re-verdict the file and say in its justification which read is which.",
  );
  for (const [relPath, count] of Object.entries(unboundedCounts)) {
    if (classification.unbounded?.[relPath]?.verdict === "FALSE-POSITIVE" && count > 1)
      console.error(`      ${relPath} — ${count} read(s) under one justification`);
  }
  failures.push(`${suppressed - MAX_SUPPRESSED_UNBOUNDED} newly suppressed unbounded read(s)`);
}

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
