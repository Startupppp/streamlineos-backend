#!/usr/bin/env node
/**
 * Gate: no service file may issue a database or cache call inside a growing loop (N+1 pattern).
 *
 * Detection — a call site is flagged when:
 *   1. A loop opener (for/while/forEach/map/reduce/flatMap/filter + await body) appears on a line.
 *   2. Within the next LOOP_BODY_LOOKFORWARD lines, a DB or cache call pattern appears.
 *
 * Patterns detected as DB/cache calls:
 *   - db.<method>( / tx.<method>( / sql`  / db.execute( / db.transaction(
 *   - this.db.<method>( / this.tx
 *   - .query.  (Drizzle relational queries)
 *   - cacheService.get / cacheService.set / redis.get / redis.set / redis.hget
 *   - Inline repository calls: .findOne( / .findBy( / .save(
 *
 * Classification file (baselines/db-call-count-classification.json):
 *   N+1-FIXED · BATCHED · FALSE-POSITIVE · EXCLUDED-MODULE · ACTIONABLE
 *
 * Failure modes:
 *   1. Unclassified path — detected file has no classification entry   → gate fails.
 *   2. Stale entry       — classification file points at a missing file → gate fails.
 *   3. Regression        — file classified N+1-FIXED/BATCHED/FALSE-POSITIVE still detected → gate fails.
 *
 * ACTIONABLE entries do not fail; they are counted as the ratchet to drive to zero.
 *
 * --self-test          : run proof-of-failure tests and exit.
 * --emit-classification: write a fresh classification.json from current scan; new entries = ACTIONABLE.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";

const LOOP_BODY_LOOKFORWARD = 30;
const MIN_FILES = 200;
const MIN_MODULES = 40;

const ROOT = new URL("../modules", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const CLASSIFICATION_FILE = new URL(
  "./baselines/db-call-count-classification.json",
  import.meta.url,
).pathname.replace(/^\/([A-Z]:)/, "$1");

const EXCLUDED_MODULE_PREFIXES = ["/crm/", "/inventory/"];

const LOOP_OPENERS = [
  /\bfor\s*\(/,
  /\bwhile\s*\(/,
  /\bdo\s*\{/,
  /\.forEach\s*\(/,
  /\.map\s*\(/,
  /\.flatMap\s*\(/,
  /\.filter\s*\(/,
  /\.reduce\s*\(/,
  /\.for\s*\(/,
];

const DB_CALL_PATTERNS = [
  /\b(?:this\.)?db\s*\.\s*(?:select|insert|update|delete|execute|transaction|query|unsafe)\s*\(/,
  /\b(?:this\.)?tx\s*\.\s*(?:select|insert|update|delete|execute|unsafe)\s*\(/,
  /\bsql\s*`/,
  /\.query\s*\.\s*\w+\s*\.\s*(?:findFirst|findMany)\s*\(/,
  /\bawait\s+\w*[Cc]ache[Ss]ervice\s*\.\s*(?:get|set|del|hget|hset)\s*\(/,
  /\bredisClient\s*\.\s*(?:get|set|del|hget|hset|lpush|rpush)\s*\(/,
  /\bredis\s*\.\s*(?:get|set|del|hget|hset|lpush|rpush)\s*\(/,
  /\bawait\s+\w+Repository\s*\.\s*(?:findOne|findBy|save|update|delete)\s*\(/,
  // A helper that RECEIVES the handle issues the query just as surely as one that
  // owns it. Matching only `db.select(` saw the handle as a receiver and never as
  // an argument, so `await pullAttendanceInputs(this.db, ...)` inside a loop —
  // payroll/runs/inputs.service.ts, ~4,000 serial round-trips — read as clean.
  /\bawait\s+(?:this\.)?[\w.]+\s*\(\s*(?:this\.)?(?:db|tx)\s*[,)]/,
];

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
      try { return statSync(join(ROOT, entry)).isDirectory(); } catch { return false; }
    })
    .sort();
}

function collectServiceFiles(dir) {
  const files = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return files; }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectServiceFiles(full));
    } else if (
      stat.isFile() &&
      extname(entry) === ".ts" &&
      !entry.endsWith(".spec.ts") &&
      !entry.endsWith(".e2e-spec.ts") &&
      !entry.endsWith(".module.ts") &&
      !entry.endsWith(".controller.ts") &&
      !entry.endsWith(".decorator.ts") &&
      !entry.endsWith(".guard.ts") &&
      !entry.endsWith(".interceptor.ts") &&
      !entry.endsWith(".filter.ts")
    ) {
      files.push(full);
    }
  }
  return files;
}

function parenBalance(line) {
  let depth = 0;
  let inStr = false;
  let strChar = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === strChar && line[i - 1] !== "\\") inStr = false;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inStr = true; strChar = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    }
  }
  return depth;
}

function braceDepthChange(line) {
  let depth = 0;
  let inStr = false;
  let strChar = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === strChar && line[i - 1] !== "\\") inStr = false;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inStr = true; strChar = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
    }
  }
  return depth;
}

/**
 * A `{` that opens a loop body, not one inside a template-literal placeholder.
 *
 * The raw `/{/` test counted the brace in `${id}`, so a self-contained one-liner
 * like `ids.map((id) => sql`${id}`)` looked as though it opened a multi-line
 * body. The skip for a balanced single-line loop was then disabled and the
 * scanner walked 30 lines forward into whatever construct followed, reporting a
 * DB call that belonged to something else entirely.
 */
function loopBodyOpenedOnLine(line) {
  return /{/.test(line.replaceAll("${", ""));
}

function loopParensBalanced(line) {
  return parenBalance(line) >= 0;
}

export function detectLoopDbCalls(src) {
  const lines = src.split("\n");
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLoopLine = LOOP_OPENERS.some((re) => re.test(line));
    if (!isLoopLine) continue;

    const opensBodyOnSameLine = loopBodyOpenedOnLine(line);
    const parensClosedOnSameLine = loopParensBalanced(line);

    if (parensClosedOnSameLine && !opensBodyOnSameLine) continue;

    let depth = 0;
    let enteredBody = false;
    const end = Math.min(i + LOOP_BODY_LOOKFORWARD, lines.length);
    // Testing one line at a time could not see a chain broken across lines:
    // `await this.db` on one line and `.select(` on the next never matched, so
    // every formatted Drizzle query inside a loop was invisible. The patterns
    // already separate their tokens with `\s*`, so running them over the body
    // text accumulated so far spans a newline and nothing else — two statements
    // on adjacent lines still cannot bridge, because `;` is not whitespace.
    let bodySoFar = "";
    for (let j = i; j < end; j++) {
      const bodyLine = lines[j];
      const bdelta = braceDepthChange(bodyLine);
      if (!enteredBody && bdelta > 0) enteredBody = true;
      depth += bdelta;
      if (enteredBody && depth <= 0) break;
      if (enteredBody && j > i) {
        bodySoFar += (bodySoFar ? "\n" : "") + bodyLine;
        if (DB_CALL_PATTERNS.some((re) => re.test(bodySoFar))) {
          violations.push({ loopLine: i + 1, callLine: j + 1, text: bodyLine.trim() });
          break;
        }
      }
    }
  }
  return violations;
}

export function checkForUnclassified(counts, classification) {
  const unclassified = [];
  for (const relPath of Object.keys(counts))
    if (!classification[relPath]) unclassified.push(relPath);
  return unclassified;
}

export function checkForStaleEntries(classification, root) {
  const stale = [];
  const rootFwd = root.replace(/\\/g, "/");
  for (const relPath of Object.keys(classification)) {
    try { statSync(rootFwd + relPath); } catch { stale.push(relPath); }
  }
  return stale;
}

/**
 * Only a claim of REMOVAL can regress.
 *
 * `BATCHED` used to sit here beside `N+1-FIXED`, and that made the verdict
 * unusable: `BATCHED` means "the loop is still there and still issues a call,
 * but the call is batched/bounded and that is correct" — so the detector is
 * SUPPOSED to keep matching it. Treating a still-detected `BATCHED` file as a
 * regression meant the one verdict that says "I looked and this is fine" also
 * guaranteed a red gate, which trains people to reclassify rather than to fix.
 * The evidence is in the baseline: zero files carry `BATCHED` and 75 carry
 * `FALSE-POSITIVE`, which is where the batched loops went — a batched loop is
 * not a false positive of the detector, it is a true positive with an acceptable
 * verdict, and calling it a miss is how a detector gets tuned blind.
 *
 * `N+1-FIXED` still means the loop no longer issues a call, so a still-detected
 * `N+1-FIXED` file is a genuine regression and stays here.
 */
const FIXED_VERDICTS = new Set(["N+1-FIXED"]);

/** Verdicts that assert the detector will keep matching the file. */
const STILL_DETECTED_VERDICTS = new Set(["BATCHED", "FALSE-POSITIVE", "ACTIONABLE"]);

/**
 * Entries asserting "still detected" that the detector no longer matches.
 * MEASURED 2 on 2026-09-02, both FALSE-POSITIVE and both owned elsewhere:
 *   /cron/cron-hr-retention-documents.ts — a file ticket 37 CREATED by splitting
 *     cron-hr-retention.service.ts, whose classification note records the re-key.
 *     A split moves code into a filename the baseline has never seen, and this is
 *     the second gate to trip on that one file (check:unbounded-reads is the other).
 *   /hr/global/compliance-requirements.service.ts — classified by reading, and the
 *     detector has since stopped matching it.
 * Ratcheted rather than blocking so this check cannot red a gate that is green on
 * everything else while ticket 21's second pass is live in the same baseline file.
 * It may only go down.
 */
const UNDETECTED_CLAIM_BASELINE = 2;

export function checkForRegressions(counts, classification) {
  const regressions = [];
  for (const relPath of Object.keys(counts)) {
    const verdict = classification[relPath]?.verdict;
    if (verdict && FIXED_VERDICTS.has(verdict))
      regressions.push({ file: relPath, verdict });
  }
  return regressions;
}

/**
 * The other direction, and the reason removing BATCHED from FIXED_VERDICTS does
 * not turn it into a permanent exemption: an entry that asserts the detector
 * still matches it, which the detector no longer matches, is stale. Either the
 * code was fixed (reclassify to N+1-FIXED) or the detector lost sight of it
 * (a false negative, which is the failure shape this repository keeps producing).
 * Both need a human; neither may pass silently.
 */
export function checkForUndetectedClaims(counts, classification) {
  const undetected = [];
  for (const [relPath, entry] of Object.entries(classification)) {
    if (!STILL_DETECTED_VERDICTS.has(entry?.verdict)) continue;
    if (counts[relPath] === undefined) undetected.push({ file: relPath, verdict: entry.verdict });
  }
  return undetected;
}

export function countActionable(counts, classification) {
  let total = 0;
  for (const relPath of Object.keys(counts))
    if (classification[relPath]?.verdict === "ACTIONABLE") total += counts[relPath];
  return total;
}

function isExcludedModule(relPath) {
  return EXCLUDED_MODULE_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function runSelfTests() {
  const knownBadForLoop = `
    async processList(items: Item[]) {
      const result = [];
      for (const item of items) {
        const record = await this.db.query.records.findFirst({ where: eq(records.id, item.id) });
        result.push(record);
      }
      return result;
    }
  `;
  const knownBadForEach = `
    async enrichAll(members: Member[]) {
      members.forEach(async (m) => {
        const data = await this.db.select().from(profiles).where(eq(profiles.userId, m.userId)).limit(1);
        m.profile = data[0];
      });
    }
  `;
  const knownGoodBatch = `
    async processList(items: Item[]) {
      const ids = items.map(i => i.id);
      const records = await this.db.select().from(table).where(inArray(table.id, ids)).limit(ids.length + 1);
      const map = new Map(records.map(r => [r.id, r]));
      return items.map(i => ({ ...i, record: map.get(i.id) }));
    }
  `;
  const knownGoodNoAwaitInLoop = `
    async process(items: Item[]) {
      const syncResult = [];
      for (const item of items) {
        syncResult.push(transform(item));
      }
      return this.db.insert(table).values(syncResult).returning();
    }
  `;

  {
    const v = detectLoopDbCalls(knownBadForLoop);
    if (v.length === 0) {
      console.error("SELF-TEST FAIL: N+1 in for-loop (db.query.records.findFirst) was not detected");
      process.exit(1);
    }
  }
  {
    const v = detectLoopDbCalls(knownBadForEach);
    if (v.length === 0) {
      console.error("SELF-TEST FAIL: N+1 in forEach (db.select inside forEach) was not detected");
      process.exit(1);
    }
  }
  {
    const v = detectLoopDbCalls(knownGoodBatch);
    if (v.length > 0) {
      console.error(
        `SELF-TEST FAIL: known-good batch pattern was flagged as N+1 (${v.length} violations)`,
      );
      process.exit(1);
    }
  }
  {
    const v = detectLoopDbCalls(knownGoodNoAwaitInLoop);
    if (v.length > 0) {
      console.error(
        `SELF-TEST FAIL: loop with no DB call inside was incorrectly flagged (${v.length} violations)`,
      );
      process.exit(1);
    }
  }
  {
    // The shape the brace test used to miss: a self-contained one-line .map whose
    // template literal contains `${`. It must not open a body and drag the next
    // 30 lines in with it.
    const knownGoodInterpolatedOneLiner = `
      async build(ids: number[]) {
        const joined = sql.join(ids.map((id) => sql\`\${id}\`), sql\`, \`);
        const rows = await this.db.select({ id: t.id }).from(t).where(sql\`x IN (\${joined})\`);
        return rows;
      }
    `;
    const v = detectLoopDbCalls(knownGoodInterpolatedOneLiner);
    if (v.length > 0) {
      console.error(
        `SELF-TEST FAIL: a one-line .map containing \${} was treated as opening a loop body (${v.length} violations)`,
      );
      process.exit(1);
    }
  }
  {
    // The inverse, so the fix cannot be "ignore every brace": a genuine
    // multi-line loop whose opener also carries a template literal still bites.
    const knownBadInterpolatedLoop = `
      async each(ids: number[]) {
        for (const id of ids) {
          const row = await this.db.query.records.findFirst({ where: eq(records.id, id) });
          console.log(\`row \${row?.id}\`);
        }
      }
    `;
    const v = detectLoopDbCalls(knownBadInterpolatedLoop);
    if (v.length === 0) {
      console.error("SELF-TEST FAIL: a genuine N+1 loop was missed after the brace fix");
      process.exit(1);
    }
  }

  {
    const territory = discoverTerritory();
    if (territory.length < MIN_MODULES) {
      console.error(
        `SELF-TEST FAIL: discovered only ${territory.length} module folders (expected >= ${MIN_MODULES}) — ROOT is wrong: ${ROOT}`,
      );
      process.exit(1);
    }
  }

  {
    const unclassified = checkForUnclassified(
      { "/fake/new-service.service.ts": 1 },
      {},
    );
    if (unclassified.length === 0) {
      console.error("SELF-TEST FAIL: unclassified path was not detected");
      process.exit(1);
    }
  }

  {
    const stale = checkForStaleEntries(
      { "/definitely/does-not-exist/fake.service.ts": { verdict: "ACTIONABLE" } },
      ROOT,
    );
    if (stale.length === 0) {
      console.error("SELF-TEST FAIL: stale classification entry was not detected");
      process.exit(1);
    }
  }

  {
    const regressions = checkForRegressions(
      { "/some/fixed.service.ts": 1 },
      { "/some/fixed.service.ts": { verdict: "N+1-FIXED" } },
    );
    if (regressions.length === 0) {
      console.error("SELF-TEST FAIL: regression (N+1-FIXED file still detected) was not reported");
      process.exit(1);
    }
  }

  {
    const regressions = checkForRegressions(
      { "/some/actionable.service.ts": 1 },
      { "/some/actionable.service.ts": { verdict: "ACTIONABLE" } },
    );
    if (regressions.length > 0) {
      console.error("SELF-TEST FAIL: ACTIONABLE file was incorrectly reported as a regression");
      process.exit(1);
    }
  }

  {
    // The BATCHED defect, pinned. A batched loop is SUPPOSED to keep matching the
    // detector; calling that a regression made the one verdict that means "I read
    // this and it is correct" also mean "this gate is now red", which is why the
    // baseline holds zero BATCHED files and 75 FALSE-POSITIVE ones.
    const regressions = checkForRegressions(
      { "/some/batched.service.ts": 3 },
      { "/some/batched.service.ts": { verdict: "BATCHED" } },
    );
    if (regressions.length > 0) {
      console.error("SELF-TEST FAIL: a still-detected BATCHED file was reported as a regression");
      process.exit(1);
    }
  }

  {
    // The other direction: BATCHED must not become a silent permanent exemption.
    const undetected = checkForUndetectedClaims(
      {},
      { "/some/batched.service.ts": { verdict: "BATCHED" } },
    );
    if (undetected.length !== 1) {
      console.error("SELF-TEST FAIL: a BATCHED file the detector no longer matches was not reported as stale");
      process.exit(1);
    }
  }

  {
    const undetected = checkForUndetectedClaims(
      {},
      { "/some/fixed.service.ts": { verdict: "N+1-FIXED" }, "/some/x.service.ts": { verdict: "EXCLUDED-MODULE" } },
    );
    if (undetected.length > 0) {
      console.error("SELF-TEST FAIL: N+1-FIXED / EXCLUDED-MODULE must not be reported as stale when undetected");
      process.exit(1);
    }
  }

  {
    // Regression fixtures taken from the two shapes this detector was blind to.
    // Both are the REAL code from payroll/runs/inputs.service.ts, not a synthetic
    // paraphrase: the gate reported ACTIONABLE 0 while sitting directly over them.
    const indirectHandle = [
      "    for (const row of toReset) {",
      "      const pulled = await pullAttendanceInputs(this.db, orgId, row.userId, month);",
      "      if (pulled) pulledInputs.push({ userId: row.userId, pulled });",
      "    }",
    ].join("\n");
    const multiLineChain = [
      "    for (const row of rows) {",
      "      const existing = await this.db",
      "        .select({ id: payrollInputs.id })",
      "        .from(payrollInputs);",
      "    }",
    ].join("\n");
    const noDbCall = [
      "    for (const row of rows) {",
      "      logger.log(row.id);",
      "      totals.push(compute(row));",
      "    }",
    ].join("\n");
    const adjacentStatements = [
      "    for (const row of rows) {",
      "      const handle = memoDb;",
      "      results.select(row);",
      "    }",
    ].join("\n");

    const cases = [
      ["a helper receiving the db handle as an ARGUMENT is a loop DB call", indirectHandle, 1],
      ["a Drizzle chain broken across lines is a loop DB call", multiLineChain, 1],
      ["a loop with no DB access is not a finding", noDbCall, 0],
      ["two adjacent statements do not bridge into a false match", adjacentStatements, 0],
    ];
    for (const [label, fixture, expected] of cases) {
      const got = detectLoopDbCalls(fixture).length;
      if (got !== expected) {
        console.error(`SELF-TEST FAIL: ${label} — expected ${expected} violation(s), got ${got}`);
        process.exit(1);
      }
    }
  }

  {
    // parenBalance is what stops the scanner walking past the end of a one-line
    // loop into an unrelated construct. Nothing above asserts its arithmetic, so
    // it could return a constant and every detection case would still pass.
    const cases = [
      ["for (const x of xs) {", 0],
      ["}", 0],
      ["const a = f(g(1));", 0],
      ["ids.map((id) => `(${id})`);", 0],
      ['const s = "((( unclosed in a string";', 0],
      ["foo(bar,", 1],
      [")", -1],
    ];
    for (const [line, expected] of cases) {
      if (parenBalance(line) !== expected) {
        console.error(
          `SELF-TEST FAIL: parenBalance(${JSON.stringify(line)}) = ${parenBalance(line)}, expected ${expected}`,
        );
        process.exit(1);
      }
    }
    if (!loopParensBalanced("for (const x of xs) {")) {
      console.error("SELF-TEST FAIL: an opened loop header must count as balanced-or-open");
      process.exit(1);
    }
    if (loopParensBalanced("));")) {
      console.error("SELF-TEST FAIL: a line that closes more parens than it opens is not balanced");
      process.exit(1);
    }
  }

  console.log("SELF-TEST PASS: all 12 detection/classification checks passed");
  process.exitCode = 0;
}

function loadClassification() {
  try {
    return JSON.parse(readFileSync(CLASSIFICATION_FILE, "utf8")).files ?? {};
  } catch {
    return {};
  }
}

async function main() {
  const SELF_TEST = process.argv.includes("--self-test");
  const EMIT = process.argv.includes("--emit-classification");

  if (SELF_TEST) {
    runSelfTests();
    return;
  }

  const allFiles = collectServiceFiles(ROOT);
  if (allFiles.length < MIN_FILES) {
    console.error(
      `ERROR: Only ${allFiles.length} service files found (expected >= ${MIN_FILES}) — ROOT path is wrong: ${ROOT}`,
    );
    process.exitCode = 1;
    return;
  }

  const counts = {};
  for (const file of allFiles) {
    let src;
    try { src = readFileSync(file, "utf8"); } catch { continue; }
    const violations = detectLoopDbCalls(src);
    if (violations.length > 0) {
      const relPath = normalizeRelPath(file);
      counts[relPath] = violations.length;
    }
  }

  if (EMIT) {
    const classification = loadClassification();
    const out = { version: 1, classifiedAt: new Date().toISOString().slice(0, 10),
      note: "Verdicts: N+1-FIXED|BATCHED|FALSE-POSITIVE|EXCLUDED-MODULE|ACTIONABLE", files: {} };
    for (const [relPath, count] of Object.entries(counts)) {
      out.files[relPath] = classification[relPath] ?? {
        verdict: isExcludedModule(relPath) ? "EXCLUDED-MODULE" : "ACTIONABLE",
        note: `${count} DB call(s) detected inside loop body — batch with inArray or Promise.all`,
      };
    }
    writeFileSync(CLASSIFICATION_FILE, JSON.stringify(out, null, 2) + "\n");
    console.log(`Wrote ${CLASSIFICATION_FILE} with ${Object.keys(out.files).length} entries.`);
    return;
  }

  const classification = loadClassification();

  const unclassified = checkForUnclassified(counts, classification);
  const stale = checkForStaleEntries(classification, ROOT);
  const regressions = checkForRegressions(counts, classification);
  const undetectedClaims = checkForUndetectedClaims(counts, classification);
  const actionable = countActionable(counts, classification);

  const detectedTotal = Object.keys(counts).length;
  const actionableFiles = Object.entries(classification)
    .filter(([, v]) => v.verdict === "ACTIONABLE").length;

  console.log(`Scanned ${allFiles.length} service files across ${discoverTerritory().length} modules.`);
  console.log(`Detected ${detectedTotal} file(s) with loop-internal DB calls (N+1 candidates).`);
  console.log(`  ACTIONABLE: ${actionableFiles} file(s) (${actionable} call site(s) to fix)`);

  let failed = false;

  if (unclassified.length > 0) {
    console.error(`\n${unclassified.length} UNCLASSIFIED file(s) — add to ${CLASSIFICATION_FILE}:`);
    for (const f of unclassified) {
      const n = counts[f];
      console.error(`  NEW  ${f} (${n} call site(s))`);
    }
    failed = true;
  }

  if (stale.length > 0) {
    console.error(`\n${stale.length} STALE classification entry(ies) — file no longer exists:`);
    for (const f of stale) console.error(`  STALE  ${f}`);
    failed = true;
  }

  if (regressions.length > 0) {
    console.error(`\n${regressions.length} REGRESSION(s) — marked N+1-FIXED but still detected:`);
    for (const r of regressions) console.error(`  REGRESSED  ${r.file} (was ${r.verdict})`);
    failed = true;
  }

  if (undetectedClaims.length > 0) {
    const over = undetectedClaims.length > UNDETECTED_CLAIM_BASELINE;
    const say = over ? console.error : console.log;
    say(
      `\n${undetectedClaims.length} STALE VERDICT(s) (ratchet ${UNDETECTED_CLAIM_BASELINE}) — the entry asserts the detector still matches this file, and it no longer does. Either the loop was fixed (reclassify N+1-FIXED) or the detector lost sight of it (a false negative):`,
    );
    for (const u of undetectedClaims) say(`  UNDETECTED  ${u.file} (marked ${u.verdict})`);
    if (over) failed = true;
  }

  if (!failed) {
    console.log(
      undetectedClaims.length > 0
        ? `\nEvery N+1 pattern is classified and nothing regressed. ${undetectedClaims.length} stale verdict(s) recorded above, at the ratchet of ${UNDETECTED_CLAIM_BASELINE}.`
        : "\nAll N+1 patterns are classified. No regressions or stale entries.",
    );
  }

  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error("RUNNER FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
