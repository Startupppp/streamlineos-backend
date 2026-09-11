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
const MIN_COMMON_FILES = 150;
const MIN_DB_FILES = 300;

/**
 * Floor on the number of loop openers whose body this run actually read.
 *
 * A detector that silently stops looking is the failure this file keeps
 * producing, and nothing here measured it: the gate printed "All N+1 patterns
 * are classified" while half of every loop in src/modules went uninspected.
 * Counting DETECTIONS cannot catch that — a narrower detector detects less and
 * reads as cleaner. Counting INSPECTIONS can, because removing an opener
 * pattern, restoring a `continue` or narrowing `scanBracelessBody` all drive
 * this number down.
 *
 * Measured 2026-09-03 at head, by this file: 4,776 openers · 2,736 inspected ·
 * 2,040 skipped because their statement ended on the opener line. Before the
 * braceless scanner it was 2,127 inspected against 2,638 discarded outright.
 * Floor set ~5% below the measurement so ordinary code churn does not red the
 * gate, and it may only go UP. Raise it when the repo grows; never lower it to
 * make a change fit.
 */
const MIN_INSPECTED_LOOPS = 2600;

const ROOT = new URL("../modules", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const CLASSIFICATION_FILE = new URL(
  "./baselines/db-call-count-classification.json",
  import.meta.url,
).pathname.replace(/^\/([A-Z]:)/, "$1");

const EXCLUDED_MODULE_PREFIXES = ["/crm/", "/inventory/"];

const LOOP_OPENERS = [
  // `for await (` did not match `\bfor\s*\(` — the regex wants the paren straight
  // after `for`. 13 sites in src/modules were invisible for that reason alone.
  /\bfor\s*(?:await\s+)?\(/,
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
  // `selectDistinct(` did NOT match. The alternation matches `select`, then demands
  // `\s*\(`, and the next character is `D` — so every `db.selectDistinct(...)` in a
  // loop was invisible. build/core/build-due-sweep.service.ts:123 was one.
  /\b(?:this\.)?db\s*\.\s*(?:select(?:Distinct)?|insert|update|delete|execute|transaction|query|unsafe)\s*\(/,
  /\b(?:this\.)?tx\s*\.\s*(?:select|insert|update|delete|execute|unsafe)\s*\(/,
  /\bsql\s*`/,
  /\.query\s*\.\s*\w+\s*\.\s*(?:findFirst|findMany)\s*\(/,
  /\bawait\s+\w*[Cc]ache[Ss]ervice\s*\.\s*(?:get|set|del|hget|hset)\s*\(/,
  // THE WHOLE CACHE HALF OF THE CLAUSE WAS UNENFORCED. §5.1 says "no database *or
  // cache* call inside a growing loop", and the pattern above requires the literal
  // identifier `cacheService`. This repository injects `private readonly cache:
  // CacheService` and writes `this.cache.…` — 188 call sites — so not one cache
  // round trip in a loop had ever been detected. Six were real, the widest fanning
  // out to 10,000 Redis commands from one module toggle.
  //
  // Anchored on `cache.` exactly rather than `\w*[Cc]ache`, because the in-process
  // TTL maps in this repo are named `versionCache` / `permsCache` / `tierCache` /
  // `moduleMapCache`, and `Map.prototype.delete` is not a
  // round trip. A looser pattern reports those five sweeps as N+1s.
  /\b(?:this\.)?cache\s*\.\s*(?:get|set|del|delete|wrap|cached|cachedForOrg|cachedVersioned|invalidate|invalidateMany|invalidateNamespace|invalidateNamespaceMany|invalidateForOrg|invalidateNamespaceForOrg)\s*\(/,
  /\bredisClient\s*\.\s*(?:get|set|del|hget|hset|lpush|rpush)\s*\(/,
  /\bredis\s*\.\s*(?:get|set|del|hget|hset|lpush|rpush)\s*\(/,
  /\bawait\s+\w+Repository\s*\.\s*(?:findOne|findBy|save|update|delete)\s*\(/,
  // A helper that RECEIVES the handle issues the query just as surely as one that
  // owns it. Matching only `db.select(` saw the handle as a receiver and never as
  // an argument, so `await pullAttendanceInputs(this.db, ...)` inside a loop —
  // payroll/runs/inputs.service.ts, ~4,000 serial round-trips — read as clean.
  /\bawait\s+(?:this\.)?[\w.]+\s*\(\s*(?:this\.)?(?:db|tx)\s*[,)]/,
  // The same helper-receives-the-handle shape with NO `await` in front of it, which
  // is what `ids.map((id) => ensureFromUser(this.db, id))` looks like — the callback
  // returns the promise and `Promise.all` awaits it later. The pattern above requires
  // a directly preceding `await`, so the commonest concurrent-N+1 idiom slipped past.
  // `this.` is mandatory here: dropping it would match a function DECLARATION
  // `function pull(db, orgId)`, which is not a call at all.
  /\b[\w.]+\s*\(\s*this\.(?:db|tx)\s*[,)]/,
];

/**
 * The gate reads THREE trees, not one.
 *
 * `src/modules` alone until 2026-09-03. `src/common` — the asynchronous substrate
 * where every sweep, relay and workflow lives — and `src/db` were outside the
 * corpus, so "All N+1 patterns are classified" was a statement about src/modules
 * that read as a statement about the system. Six files in src/common and three in
 * src/db carry loop-internal DB calls and none of them had ever been classified.
 *
 * The new roots carry an `@`-prefixed classification key: both `src/modules` and
 * `src/common` contain an `hr` folder, so an unprefixed union would have merged two
 * different files onto one entry. `src/modules` keeps its bare `/<module>/<path>`
 * form, so no existing entry moves.
 */
const COMMON_ROOT = new URL("../common", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const DB_ROOT = new URL("../db", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

const SCAN_ROOTS = [
  { key: "", dir: ROOT, minFiles: MIN_FILES, label: "src/modules" },
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

function bracketBalance(line) {
  let depth = 0;
  let inStr = false;
  let strChar = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === strChar && line[i - 1] !== "\\") inStr = false;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inStr = true; strChar = ch;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
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

/**
 * An opener that opened nothing — every paren, bracket and brace it opened is
 * closed again on the same line — so there is no body below it to scan.
 *
 * This is the array-callback noise. `LOOP_OPENERS` includes `.map(`/`.filter(`/
 * `.forEach(`, so a projection such as
 * `names.map((n) => ({ n, slug: slug(n) }))` counts as a loop opener. It has a
 * `{`, so the older `!loopBodyOpenedOnLine` skip did not fire; but its braces
 * net to zero, so `enteredBody` never became true either, and the scanner then
 * walked up to LOOP_BODY_LOOKFORWARD lines forward and ADOPTED THE NEXT
 * UNRELATED BLOCK as the loop body. Measured on a fixture: a one-line `.map`
 * followed by an `if` block holding a single `await this.db.select()` was
 * reported as a loop-internal DB call at the `.map` line.
 *
 * All three delimiters are required, and the bracket half is not decorative.
 * `for (const { contentType, id } of [` (kb/wiki/kb-spaces.service.ts:224) has
 * balanced BRACES from its destructuring pattern, and it is a real loop with a
 * braceless body that emits an outbox row per item. Testing braces alone would
 * have silenced a true positive, which is the failure this repository keeps
 * producing; its open paren and open bracket both keep it in scope.
 */
function openerIsSelfContained(line) {
  return parenBalance(line) === 0 && bracketBalance(line) === 0 && braceDepthChange(line) === 0;
}

/**
 * Drop a trailing `//` line comment without cutting a `//` that lives inside a
 * string — `const u = "https://x";` must keep its terminating `;`, or the
 * braceless scanner below reads the statement as unfinished and over-scans.
 */
function stripLineComment(line) {
  let inStr = false;
  let strChar = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === strChar && line[i - 1] !== "\\") inStr = false;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inStr = true; strChar = ch;
    } else if (ch === "/" && line[i + 1] === "/") {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

/**
 * THE BLIND SPOT THIS GATE WAS BUILT AROUND, and the reason it could not see two
 * thirds of the repository: a loop body that is a STATEMENT rather than a BLOCK.
 *
 * The rule that stood here — `if (parensClosedOnSameLine && !opensBodyOnSameLine)
 * continue;` — reads as "this opener has no `{`, so it has no body to scan". That
 * is true only when the opener's whole STATEMENT also ends on that line. It is
 * false for the two shapes this codebase writes most:
 *
 *   for (const row of rows)
 *     await claimIdentifiers(db, orgId, row.partyId, claimsOf(row));
 *
 * — which CLAUDE.md §6 does not merely permit but MANDATES ("Single-statement
 * `if`/`for` bodies omit braces"), so the gate was blind by construction to the
 * house style; and
 *
 *   await Promise.all(
 *     ids.map((id) =>
 *       this.db.update(t).set(...).where(eq(t.id, id)),
 *     ),
 *   );
 *
 * — the commonest hidden-N+1 idiom in a Nest/Drizzle service. Its opener line
 * `ids.map((id) =>` leaves a paren OPEN, and `loopParensBalanced` returns
 * `parenBalance >= 0`, so an unclosed opener counted as "closed" and was skipped
 * by the same `continue`.
 *
 * MEASURED at HEAD before this change, over src/modules: **2,417 of 4,765 loop
 * openers (50.7%), spread over 753 files, were discarded by that one `continue`
 * with no body inspection at all.** Widening found 14 files the gate had never
 * seen once, four of them real per-row or per-group writes —
 * clients/client-accounts.service.ts:487, party/party-legacy-employer.ts:213,
 * party/party-legacy-writer.ts:252 and settings/settings.service.ts:51.
 *
 * The body of a braceless loop is exactly one statement, so it is scanned until
 * every delimiter the opener left open is closed again AND the line terminates a
 * statement (`;`, `,` or `}`), capped at LOOP_BODY_LOOKFORWARD. Returning `null`
 * for an opener whose own statement already ended on its line is what keeps
 * `const ids = rows.map((r) => r.id);` — the noise this file has twice been
 * broken by — from adopting whatever follows it.
 */
/**
 * A ONE-LINE loop whose body is on that same line — the case every scan path here
 * missed, because all of them start looking at line i+1.
 *
 *   await Promise.all(
 *     assignees.map((a) => this.cache.invalidate(userSession(a.userId))),
 *   );
 *
 * The middle line is a loop opener AND its whole body. `openerIsSelfContained`
 * returns true for it (every delimiter closes), so it was counted as
 * `skippedComplete` and never read. So was the braceless single-line form
 * `for (const x of xs) await this.db.insert(t).values(x);`, whose statement also
 * ends on the opener line. Both are shapes this repository writes.
 *
 * The body has to be isolated from the header before matching, or the line
 *   `.where(inArray(t.id, ids.map((i) => i.id)))`
 * reports the `this.db.select(` that opened the statement as a call inside the
 * `.map` — the `.map` is an ARGUMENT to that query, not a loop around it. So:
 * for `for`/`while`, the body is whatever follows the header's matching `)`;
 * for a callback opener, it is whatever follows the callback's first `=>`.
 * Anything before that belongs to the enclosing statement and is not the body.
 */
function openerLineBody(line) {
  const header = /\b(?:for\s*(?:await\s+)?|while\s*)\(/.exec(line);
  if (header) {
    let depth = 0;
    for (let k = header.index + header[0].length - 1; k < line.length; k++) {
      if (line[k] === "(") depth++;
      else if (line[k] === ")") {
        depth--;
        if (depth === 0) return line.slice(k + 1);
      }
    }
    return "";
  }
  const arrow = line.indexOf("=>");
  return arrow === -1 ? "" : line.slice(arrow + 2);
}

/**
 * A bare `sql\`` is a FRAGMENT, not a round trip, and on a one-line callback it is
 * essentially always a fragment: `ids.map((id) => sql\`${id}\`)` builds an IN-list
 * that one statement below executes ONCE. Real one-line execution still matches,
 * because it is written `db.execute(sql\`…\`)` and the handle pattern catches it.
 * Kept out of the same-line scan only; multi-line bodies still test it.
 */
const SQL_FRAGMENT_PATTERN_SOURCE = /\bsql\s*`/.source;

function scanOpenerLine(lines, i) {
  const body = openerLineBody(lines[i]);
  if (body === "") return null;
  const hit = DB_CALL_PATTERNS.some(
    (re) => re.source !== SQL_FRAGMENT_PATTERN_SOURCE && re.test(body),
  );
  if (!hit) return null;
  return { loopLine: i + 1, callLine: i + 1, text: lines[i].trim() };
}

function scanBracelessBody(lines, i) {
  const opener = lines[i];
  let depth = parenBalance(opener) + bracketBalance(opener) + braceDepthChange(opener);
  if (depth <= 0 && /[;,]$/.test(stripLineComment(opener))) return null;

  let bodySoFar = "";
  const end = Math.min(i + 1 + LOOP_BODY_LOOKFORWARD, lines.length);
  for (let j = i + 1; j < end; j++) {
    const bodyLine = lines[j];
    bodySoFar += (bodySoFar ? "\n" : "") + bodyLine;
    if (DB_CALL_PATTERNS.some((re) => re.test(bodySoFar)))
      return { loopLine: i + 1, callLine: j + 1, text: bodyLine.trim() };
    depth += parenBalance(bodyLine) + bracketBalance(bodyLine) + braceDepthChange(bodyLine);
    if (depth <= 0 && /[;,}]$/.test(stripLineComment(bodyLine))) break;
  }
  return null;
}

/**
 * Loop openers this run actually looked inside, and the ones it did not.
 *
 * Recorded per run so the widening above cannot be quietly undone. `inspected`
 * is the number of openers whose body was read; `skippedComplete` is the number
 * whose whole statement finished on the opener line, which is the only honest
 * reason to look no further. `main` ratchets `inspected` against
 * MIN_INSPECTED_LOOPS — re-narrowing the detector drops that number and reds the
 * gate, which is exactly what did NOT happen when 2,417 openers went dark.
 */
export const coverage = { openers: 0, inspected: 0, skippedComplete: 0 };

export function resetCoverage() {
  coverage.openers = 0;
  coverage.inspected = 0;
  coverage.skippedComplete = 0;
}

export function detectLoopDbCalls(src) {
  const lines = src.split("\n");
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLoopLine = LOOP_OPENERS.some((re) => re.test(line));
    if (!isLoopLine) continue;
    coverage.openers++;

    const opensBodyOnSameLine = loopBodyOpenedOnLine(line);
    const parensClosedOnSameLine = loopParensBalanced(line);

    if (parensClosedOnSameLine && !opensBodyOnSameLine) {
      const sameLine = scanOpenerLine(lines, i);
      if (sameLine) { coverage.inspected++; violations.push(sameLine); continue; }
      const braceless = scanBracelessBody(lines, i);
      if (braceless === null && /[;,]$/.test(stripLineComment(line))) coverage.skippedComplete++;
      else coverage.inspected++;
      if (braceless) violations.push(braceless);
      continue;
    }
    if (openerIsSelfContained(line)) {
      const sameLine = scanOpenerLine(lines, i);
      if (sameLine) { coverage.inspected++; violations.push(sameLine); continue; }
      coverage.skippedComplete++;
      continue;
    }
    coverage.inspected++;

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

export function checkForStaleEntries(classification, resolve = resolveClassifiedPath) {
  const stale = [];
  for (const relPath of Object.keys(classification)) {
    try { statSync(resolve(relPath)); } catch { stale.push(relPath); }
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
 * THE INVISIBLE SET, named so it stops being invisible.
 *
 * A pattern detector can only match what looks like a database call. A residual
 * N+1 whose per-row work is a SERVICE call — `this.audit.log(row)`,
 * `applyOne(change)`, `approveSinglePeriod(period)` — is a real defect that this
 * file will never match, and there was no verdict for it. The three files that
 * carried one were left `ACTIONABLE`, which asserts "the detector still matches
 * me"; it does not, so each tripped the stale-verdict check, and the response
 * was to raise UNDETECTED_CLAIM_BASELINE. That ratchet was absorbing real
 * findings — the gate's own escape hatch for its own blindness.
 *
 * `ACTIONABLE-UNDETECTED` says the opposite of a ratchet: a human read this call
 * site, confirmed the N+1 is real, and confirmed the detector cannot see it. It
 * is excluded from STILL_DETECTED_VERDICTS (so it never reads as stale) and from
 * FIXED_VERDICTS (so it never reads as fixed), it is printed on every run, and
 * it is ratcheted at ACTIONABLE_UNDETECTED_BASELINE, which may only go DOWN.
 * Adding one is admitting a defect, not excusing it.
 */
const ACTIONABLE_UNDETECTED_VERDICT = "ACTIONABLE-UNDETECTED";

/**
 * Files holding a human-confirmed N+1 the patterns cannot match. WAS 3 on
 * 2026-09-03; fixed to 0 on 2026-09-07:
 *   /hr/core/hr-effective-change-applier.service.ts — inArray preload before loop.
 *   /hr/time/leave-approver.service.ts — Promise.all preload before loop.
 *   /timesheets/core/approvals-bulk.service.ts — set-based bulkApprove, no approveSinglePeriod per period.
 * May only go down. Do not add a file here to silence a red gate; the verdict
 * exists so that a defect the detector cannot see is still counted as a defect.
 */
const ACTIONABLE_UNDETECTED_BASELINE = 0;

/**
 * Entries asserting "still detected" that the detector no longer matches.
 *
 * WAS 2 and is now 0. Both files it named are gone from the baseline: the
 * keyset drain in /access/access-permission.resolver.ts no longer exists in that
 * file, and /cron/cron-hr-retention-documents.ts:33 is a pure in-memory filter
 * whose only `sql` template sits in a different function below the loop — both
 * were obsolete FALSE-POSITIVE excuses, and both are removed rather than
 * ratcheted. The three entries this number was really absorbing were real
 * findings and now carry ACTIONABLE-UNDETECTED. It may only go down.
 */
const UNDETECTED_CLAIM_BASELINE = 0;

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

/**
 * The invisible set, listed. These entries are found in the CLASSIFICATION, not
 * in `counts`, because being absent from `counts` is the whole point of them.
 */
export function listActionableUndetected(classification) {
  return Object.entries(classification)
    .filter(([, v]) => v?.verdict === ACTIONABLE_UNDETECTED_VERDICT)
    .map(([file, v]) => ({ file, note: v.note ?? "" }));
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
    const stale = checkForStaleEntries({
      "/definitely/does-not-exist/fake.service.ts": { verdict: "ACTIONABLE" },
    });
    if (stale.length === 0) {
      console.error("SELF-TEST FAIL: stale classification entry was not detected");
      process.exit(1);
    }
  }

  // Three roots, and the prefixes that keep them apart. src/modules and src/common
  // both hold an `hr` folder, so an unprefixed union would silently merge two files
  // onto one classification entry.
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
    const key = normalizeRelPath(join(commonRoot.dir, "tenant/for-each-org.ts"), commonRoot);
    if (key !== "@common/tenant/for-each-org.ts") {
      console.error(`SELF-TEST FAIL: a src/common path normalised to "${key}", not an @common key`);
      process.exit(1);
    }
    if (resolveClassifiedPath(key) !== `${commonRoot.dir}/tenant/for-each-org.ts`) {
      console.error("SELF-TEST FAIL: an @common classification key does not resolve back to its file");
      process.exit(1);
    }
    const moduleKey = normalizeRelPath(join(ROOT, "hr/x.service.ts"), SCAN_ROOTS[0]);
    if (moduleKey !== "/hr/x.service.ts" || resolveClassifiedPath(moduleKey) !== `${ROOT}/hr/x.service.ts`) {
      console.error("SELF-TEST FAIL: a src/modules key no longer round-trips unprefixed");
      process.exit(1);
    }
    if (checkForStaleEntries({ "@common/tenant/for-each-org.ts": { verdict: "ACTIONABLE" } }).length > 0) {
      console.error("SELF-TEST FAIL: a live @common entry was reported stale — the key does not resolve");
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

  {
    // The two shapes the array-callback opener produced, pinned in BOTH
    // directions — the noise it must lose, and the true positive it must keep.
    const arrayCallbackAdoptingNextBlock = [
      "    const mapped = names.map((n) => ({ n, slug: slug(n) }));",
      "    if (mapped.length) {",
      "      const rows = await this.db",
      "        .select()",
      "        .from(t);",
      "      return rows;",
      "    }",
    ].join("\n");
    // Real code, kb/wiki/kb-spaces.service.ts:224. Balanced BRACES from the
    // destructuring pattern, an OPEN paren and an OPEN bracket, a braceless
    // body, and a per-item outbox write. Testing braces alone silences it.
    const bracelessForOverArrayLiteral = [
      "        for (const { contentType, id } of [",
      "          ...articles.map((row) => ({ contentType: \"article\", id: row.id })),",
      "        ])",
      "          await OutboxWriter.emit(tx, {",
      "            eventId: randomUUID(),",
      "            payload: { contentType, contentId: id },",
      "          });",
    ].join("\n");
    const wrappedChainInLoop = [
      "    for (const id of ids) {",
      "      const row = await this.db",
      "        .select({ id: t.id })",
      "        .from(t);",
      "    }",
    ].join("\n");
    const templatePlaceholderOneLiner = [
      "    const parts = ids.map((id) => sql`${id}`);",
      "    if (parts.length) {",
      "      const rows = await this.db",
      "        .select()",
      "        .from(t);",
      "    }",
    ].join("\n");
    const openCallbackBodyStillScanned = [
      "    await Promise.all(",
      "      ids.map(async (id) => {",
      "        const row = await this.db",
      "          .select()",
      "          .from(t);",
      "        return row;",
      "      }),",
      "    );",
    ].join("\n");

    const cases = [
      ["a balanced one-line array callback must not adopt the next block", arrayCallbackAdoptingNextBlock, 0],
      ["a braceless for over an array literal is still a loop DB call", bracelessForOverArrayLiteral, 1],
      ["a Prettier-wrapped chain inside a for-of is still a loop DB call", wrappedChainInLoop, 1],
      ["a ${} placeholder does not make a one-liner into a body opener", templatePlaceholderOneLiner, 0],
      ["a callback whose brace body IS left open is still scanned", openCallbackBodyStillScanned, 1],
    ];
    for (const [label, fixture, expected] of cases) {
      const got = detectLoopDbCalls(fixture).length;
      if (got !== expected) {
        console.error(`SELF-TEST FAIL: ${label} — expected ${expected} violation(s), got ${got}`);
        process.exit(1);
      }
    }

    const balancedCases = [
      ["names.map((n) => ({ n, slug: slug(n) }));", true],
      ["for (const x of xs) {", false],
      ["for (const { a, b } of [", false],
      ["columns.map(({ table, column }) =>", false],
      ["const parts = ids.map((id) => sql`${id}`);", true],
    ];
    for (const [line, expected] of balancedCases) {
      if (openerIsSelfContained(line) !== expected) {
        console.error(
          `SELF-TEST FAIL: openerIsSelfContained(${JSON.stringify(line)}) = ${openerIsSelfContained(line)}, expected ${expected}`,
        );
        process.exit(1);
      }
    }
  }

  {
    // The braceless-body blind spot, pinned in BOTH directions. Every HIT case
    // here returned 0 before this pass, and every MISS case is the noise that
    // widening must not start reporting.
    const bracelessForStatement = [
      "    for (const row of rows)",
      "      await claimIdentifiers(db, organizationId, row.partyId, claimsOf(row));",
    ].join("\n");
    const bracelessArrowInPromiseAll = [
      "    await Promise.all(",
      "      Object.entries(assignments).map(([assigneeId, ids]) =>",
      "        this.db",
      "          .update(clientAccounts)",
      "          .set({ assignedCrmId: assigneeId })",
      "          .where(inArray(clientAccounts.id, ids)),",
      "      ),",
      "    );",
    ].join("\n");
    const bracelessWhile = [
      "    while (cursor)",
      "      cursor = await this.db.query.rows.findFirst({ where: gt(rows.id, cursor) });",
    ].join("\n");
    const forAwaitLoop = [
      "    for await (const page of pageRecipients(this.db, orgId))",
      "      await this.db.insert(deliveries).values(page);",
    ].join("\n");
    // The noise. A one-line projection whose statement ENDS on its own line must
    // not adopt the statement that follows it — this is the exact regression the
    // `openerIsSelfContained` fix was written for, re-asserted for the braceless
    // path that now runs before it.
    const completedOneLineMap = [
      "    const ids = rows.map((r) => r.id);",
      "    const found = await this.db.select().from(t).where(inArray(t.id, ids));",
    ].join("\n");
    const completedChainWithFor = [
      "    const locked = await this.db.select().from(t).where(eq(t.id, id)).for('update');",
      "    const other = await this.db.select().from(u);",
    ].join("\n");
    const rowLockContinuation = [
      "      .for('update')",
      "      .limit(1);",
    ].join("\n");

    const cases = [
      ["a braceless for body is a loop DB call", bracelessForStatement, 1],
      ["a braceless arrow inside Promise.all(map) is a loop DB call", bracelessArrowInPromiseAll, 1],
      ["a braceless while body is a loop DB call", bracelessWhile, 1],
      ["a for-await loop body is a loop DB call", forAwaitLoop, 1],
      ["a one-line .map that ends in a semicolon must not adopt the next statement", completedOneLineMap, 0],
      ["a completed chain carrying .for('update') is not a loop", completedChainWithFor, 0],
      ["a .for('update') chain continuation is not a loop DB call", rowLockContinuation, 0],
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
    // THE THREE DETECTOR GAPS CLOSED THIS PASS, pinned in both directions. Every
    // HIT case here scored 0 before the patterns were widened; every MISS case is
    // the noise the widening must not start reporting.
    const cacheInLoop = [
      "    for (const userId of userIds)",
      "      await this.cache.invalidate(CACHE_KEYS.userSession(userId));",
    ].join("\n");
    const cachePromiseAllMap = [
      "    await Promise.all(",
      "      assignees.map((a) => this.cache.invalidate(CACHE_KEYS.userSession(a.userId))),",
      "    );",
    ].join("\n");
    const selectDistinctInLoop = [
      "    for (const sprint of ending) {",
      "      const owners = await this.db.selectDistinct({ id: t.id }).from(t);",
      "    }",
    ].join("\n");
    const helperHandleNoAwait = [
      "    await Promise.all(",
      "      members.map((m) => ensureFromUser(this.db, m.userId)),",
      "    );",
    ].join("\n");
    // The noise. An in-process Map named `...Cache` is not a round trip, and a
    // looser `\\w*[Cc]ache` pattern would report all five of this repo's TTL sweeps.
    const inMemoryMapSweep = [
      "    for (const [key, entry] of this.versionCache) {",
      "      if (entry.expiresAt <= now) this.versionCache.delete(key);",
      "    }",
    ].join("\n");
    const permsMapSweep = [
      "    for (const [key, entry] of this.permsCache) {",
      "      if (entry.expiresAt <= sweep) this.permsCache.delete(key);",
      "    }",
    ].join("\n");
    // A function DECLARATION taking a handle is not a call — this is why `this.`
    // is mandatory in the no-await helper pattern.
    const handleParamDeclaration = [
      "    for (const row of rows) {",
      "      const shape = describe(row);",
      "    }",
      "    export async function pullInputs(db: Db, orgId: string) {",
      "      return db.select().from(t);",
      "    }",
    ].join("\n");

    const cases = [
      ["a this.cache call in a braceless loop is a loop cache call", cacheInLoop, 1],
      ["a this.cache call inside Promise.all(map) is a loop cache call", cachePromiseAllMap, 1],
      ["db.selectDistinct( inside a loop is a loop DB call", selectDistinctInLoop, 1],
      ["a helper receiving this.db with NO await is a loop DB call", helperHandleNoAwait, 1],
      ["an in-process Map named versionCache is not a cache round trip", inMemoryMapSweep, 0],
      ["an in-process Map named permsCache is not a cache round trip", permsMapSweep, 0],
      ["a function declaration taking a db parameter is not a loop DB call", handleParamDeclaration, 0],
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
    // The coverage counter itself, which is what ratchets the widening in place.
    // Without this it could return a constant and MIN_INSPECTED_LOOPS would be
    // decorative.
    resetCoverage();
    detectLoopDbCalls(
      [
        "    const ids = rows.map((r) => r.id);",
        "    for (const row of rows)",
        "      await touch(this.db, row.id);",
        "    for (const row of rows) {",
        "      await this.db.insert(t).values(row);",
        "    }",
      ].join("\n"),
    );
    if (coverage.openers !== 3 || coverage.inspected !== 2 || coverage.skippedComplete !== 1) {
      console.error(
        `SELF-TEST FAIL: coverage counters wrong — openers=${coverage.openers} inspected=${coverage.inspected} skippedComplete=${coverage.skippedComplete}, expected 3/2/1`,
      );
      process.exit(1);
    }
    resetCoverage();
  }

  {
    // stripLineComment is load-bearing for the braceless terminator test: cut a
    // `//` inside a string and the statement reads as unfinished, so the scanner
    // runs on into the next one and invents a finding.
    const cases = [
      ['const u = "https://x";', 'const u = "https://x";'],
      ["await run(); // trailing", "await run();"],
      ["const p = `a//b`;", "const p = `a//b`;"],
      ["  // whole line", ""],
    ];
    for (const [line, expected] of cases) {
      if (stripLineComment(line) !== expected) {
        console.error(
          `SELF-TEST FAIL: stripLineComment(${JSON.stringify(line)}) = ${JSON.stringify(stripLineComment(line))}, expected ${JSON.stringify(expected)}`,
        );
        process.exit(1);
      }
    }
  }

  {
    // ACTIONABLE-UNDETECTED must be inert to BOTH directional checks, or it is
    // just another name for a red gate and nobody will use it.
    const entry = { "/hr/x.service.ts": { verdict: ACTIONABLE_UNDETECTED_VERDICT, note: "applyOne per row" } };
    if (checkForUndetectedClaims({}, entry).length > 0) {
      console.error("SELF-TEST FAIL: ACTIONABLE-UNDETECTED must not be reported as a stale verdict");
      process.exit(1);
    }
    if (checkForRegressions({ "/hr/x.service.ts": 1 }, entry).length > 0) {
      console.error("SELF-TEST FAIL: ACTIONABLE-UNDETECTED must not be reported as a regression");
      process.exit(1);
    }
    if (listActionableUndetected(entry).length !== 1) {
      console.error("SELF-TEST FAIL: ACTIONABLE-UNDETECTED was not listed in the invisible set");
      process.exit(1);
    }
    if (listActionableUndetected({ "/a.ts": { verdict: "ACTIONABLE" } }).length !== 0) {
      console.error("SELF-TEST FAIL: an ordinary ACTIONABLE entry leaked into the invisible set");
      process.exit(1);
    }
  }

  console.log("SELF-TEST PASS: all 44 detection/classification/coverage checks passed");
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

  const perRoot = [];
  const counts = {};
  let allFilesCount = 0;
  for (const root of SCAN_ROOTS) {
    const files = collectServiceFiles(root.dir);
    if (files.length < root.minFiles) {
      console.error(
        `ERROR: ${root.label} yielded only ${files.length} service files (expected >= ${root.minFiles}) — that root resolved to nothing or to the wrong tree: ${root.dir}`,
      );
      process.exitCode = 1;
      return;
    }
    perRoot.push({ ...root, scanned: files.length });
    allFilesCount += files.length;
    for (const file of files) {
      let src;
      try { src = readFileSync(file, "utf8"); } catch { continue; }
      const violations = detectLoopDbCalls(src);
      if (violations.length > 0) counts[normalizeRelPath(file, root)] = violations.length;
    }
  }
  const allFiles = { length: allFilesCount };

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
  const stale = checkForStaleEntries(classification);
  const regressions = checkForRegressions(counts, classification);
  const undetectedClaims = checkForUndetectedClaims(counts, classification);
  const actionable = countActionable(counts, classification);
  const actionableUndetected = listActionableUndetected(classification);

  const detectedTotal = Object.keys(counts).length;
  const actionableFiles = Object.entries(classification)
    .filter(([, v]) => v.verdict === "ACTIONABLE").length;

  console.log(`Scanned ${allFiles.length} service files across ${SCAN_ROOTS.length} roots:`);
  for (const root of perRoot)
    console.log(
      `  ${root.label.padEnd(12)}: ${root.scanned} file(s)${root.key === "" ? ` across ${discoverTerritory().length} modules` : ""}`,
    );
  console.log(
    `Loop coverage: ${coverage.openers} loop opener(s) — ${coverage.inspected} inspected, ${coverage.skippedComplete} skipped (statement ended on the opener line).`,
  );
  console.log(`Detected ${detectedTotal} file(s) with loop-internal DB calls (N+1 candidates).`);
  console.log(`  ACTIONABLE: ${actionableFiles} file(s) (${actionable} call site(s) to fix)`);
  console.log(
    `  ACTIONABLE-UNDETECTED: ${actionableUndetected.length} file(s) (ratchet ${ACTIONABLE_UNDETECTED_BASELINE}) — a real N+1 these patterns cannot match, because the per-row work is a service call:`,
  );
  for (const u of actionableUndetected) console.log(`    INVISIBLE  ${u.file}`);

  let failed = false;

  if (actionableUndetected.length > ACTIONABLE_UNDETECTED_BASELINE) {
    console.error(
      `\nINVISIBLE-SET REGRESSION: ${actionableUndetected.length} ACTIONABLE-UNDETECTED file(s) against a ratchet of ${ACTIONABLE_UNDETECTED_BASELINE}. This verdict records a defect the detector cannot see; it may only go down.`,
    );
    failed = true;
  }

  if (coverage.inspected < MIN_INSPECTED_LOOPS) {
    console.error(
      `\nCOVERAGE REGRESSION: only ${coverage.inspected} loop opener(s) were inspected (floor ${MIN_INSPECTED_LOOPS}). The detector is looking at less of the repository than it did — a narrower detector reports fewer findings and reads as cleaner, which is why this is a hard failure and not a note.`,
    );
    failed = true;
  }

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

/**
 * Run only when invoked as a script. Importing this module to reuse
 * `detectLoopDbCalls` used to run the entire repository scan as an import side
 * effect, which makes it untestable from a spec and produces a stray exit code
 * in whatever imported it.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly)
  main().catch((e) => {
    console.error("RUNNER FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
