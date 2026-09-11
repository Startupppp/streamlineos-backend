#!/usr/bin/env node
/**
 * Gate: every creation path for a plan-limited resource calls
 * `PlanLimitsService.assertWithinLimit(orgId, "<key>", ...)` BEFORE the insert
 * that consumes the quota.
 *
 * Nothing gated this class before. It was believed true only by hand-audit —
 * exactly the state ticket 06 found for lifecycle predicates before
 * check-lifecycle-predicates.mjs existed, and the same shape of gap: a
 * property enforced by convention at ~35 call sites across 14 unrelated
 * modules, with no mechanical check that a 15th key, or a 36th call site,
 * keeps the property.
 *
 * THE KEY LIST IS DERIVED, NEVER COPIED. `parseLimitKeys` reads the
 * `LimitKey` union straight out of plan-entitlements.constants.ts. A gate that
 * hardcodes the 14 strings stops covering a 15th key the moment someone adds
 * one — it would still report clean while the new resource ships with no
 * quota enforcement at all. Deriving from source is the only way "the key
 * list" and "the thing being checked" cannot drift apart.
 *
 * WHAT IS PROVEN VS ASSUMED
 *   1. Coverage — every key in the derived LimitKey union has at least one
 *      call site. A key with ZERO call sites is a real finding (MISSING-KEY)
 *      and fails the gate; it is never silently excluded.
 *   2. Ordering, where visible — for each call site, the smallest enclosing
 *      function/method body is located by brace balancing, and searched for
 *      a `.insert(` before and after the assert call:
 *        DIRECT            an insert follows the assert in the same body.
 *        ORDER-VIOLATION   an insert PRECEDES the assert in the same body —
 *                           a real bug (check-after-write), fails the gate.
 *        DELEGATED         no insert is visible in the enclosing body at all.
 *                           The write happens behind a helper this scanner
 *                           does not follow across files (`createMirroredLead`,
 *                           `createMirroredContact`, and similar). This is
 *                           reported honestly as UNVERIFIED, not counted as a
 *                           pass, and does not by itself fail the gate — module
 *                           boundaries are a legitimate reason a static text
 *                           scanner cannot see the write, and treating every
 *                           helper indirection as a violation would make the
 *                           gate impossible to keep green without inlining
 *                           code for a scanner's benefit. `--list` prints every
 *                           DELEGATED site so a human can verify the ones that
 *                           matter.
 *   3. The seat/member advisory lock — BE/CLAUDE.md's RBAC section requires
 *      the per-org `quota:${orgId}:members` transaction advisory lock
 *      immediately before every membership insert, so it is checked
 *      separately and unconditionally for every "members" call site: the lock
 *      (`lockMembersQuota(` or the literal key) must appear in the SAME
 *      enclosing body, before the assert call. A "members" site with no lock
 *      in reach is LOCK-MISSING and fails the gate — this is the one class
 *      where DELEGATED is not an acceptable answer, because the lock is
 *      cheap to co-locate and every existing site does.
 *
 * KNOWN LIMITS (static text scanning, not a call graph):
 *   - A call reached through a dynamically resolved key, an interface token,
 *     or a callback passed as an argument produces no finding at all.
 *   - The one-hop-across-files case (assert lives in file A, insert in file B,
 *     reached by a named export) is not followed; such a site reports
 *     DELEGATED even when the write is in fact ordered correctly.
 *   - A `.insert(` in the enclosing body that targets an unrelated table
 *     (e.g. an audit log write before the guarded insert) can misclassify a
 *     correct site as ORDER-VIOLATION. None were observed in the corpus this
 *     gate measured, but the risk is structural and is why every
 *     ORDER-VIOLATION prints its full statement window for human review
 *     rather than only its verdict.
 *
 * Flags:
 *   --self-test   Fixture-driven assertions, no repository scan.
 *   --list        Print every call site with its key and classification.
 *
 * Exit codes:
 *   0 no MISSING-KEY, no ORDER-VIOLATION, no LOCK-MISSING (self-test: all pass)
 *   1 a new finding of one of those three kinds (self-test: a failure)
 *   2 the scan is vacuous — it resolved too few keys, files or call sites, so
 *     a clean result would prove nothing
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const LIST = process.argv.includes("--list");

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = join(SCRIPT_DIR, "../..");
const SRC = join(BACKEND_ROOT, "src");
const CONSTANTS_FILE = join(SRC, "modules", "billing", "core", "plan-entitlements.constants.ts");

const MIN_KEYS = 14;
const MIN_CALL_SITES = 30;
const MIN_SCANNED_FILES = 2000;

const MEMBERS_KEY = "members";
const LOCK_MARKERS = ["lockMembersQuota(", "quota:${orgId}:members", "quota:\" + orgId + \":members"];

/**
 * Table-to-key mapping for the inverse check: for each entry, every
 * `.insert(TABLE)` in the corpus must be preceded by an
 * `assertWithinLimit(_, "KEY", ...)` in the same enclosing function body.
 *
 * Currently covers hrCandidates/candidates.  Adding an entry here is the
 * canonical way to extend coverage to a new resource without touching the
 * key-coverage check above.
 */
const TABLE_KEY_MAP = [
  { table: "candidates", key: "hrCandidates" },
];

/** Anti-vacuity: the corpus must contain at least this many .insert(candidates) sites. */
const MIN_CANDIDATES_INSERTS = 5;

// -- source-of-truth parsing --------------------------------------------------

/** The LimitKey union, read straight from plan-entitlements.constants.ts. */
export function parseLimitKeys(source) {
  const block = /export type LimitKey =\s*([\s\S]*?);/.exec(source);
  if (!block) return [];
  const keys = [];
  const re = /"([A-Za-z][A-Za-z0-9]*)"/g;
  let m;
  while ((m = re.exec(block[1])) !== null) keys.push(m[1]);
  return keys;
}

// -- generic text helpers (self-contained; each gate in this repo owns its own copy) --

function stripCommentsAndStrings(src) {
  const out = [];
  let i = 0;
  let inBlock = false;
  let inString = null;

  while (i < src.length) {
    const ch = src[i];

    if (inBlock) {
      if (ch === "*" && src[i + 1] === "/") {
        out.push(" ", " ");
        i += 2;
        inBlock = false;
      } else {
        out.push(ch === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }

    if (inString !== null) {
      if (ch === "\\") {
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (ch === inString) {
        out.push(" ");
        inString = null;
        i++;
        continue;
      }
      if (ch === "\n" && inString !== "`") {
        out.push("\n");
        inString = null;
        i++;
        continue;
      }
      out.push(ch === "\n" ? "\n" : " ");
      i++;
      continue;
    }

    if (ch === "/" && src[i + 1] === "*") {
      out.push(" ", " ");
      i += 2;
      inBlock = true;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out.push(" ");
      i++;
      continue;
    }

    out.push(ch);
    i++;
  }

  return out.join("");
}

/** The text of a balanced bracket group starting at `from`, inclusive. */
export function balanced(src, from) {
  let depth = 0;
  let inString = null;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (inString !== null) {
      if (ch === "\\") { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return null;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** Every matching `{ ... }` pair in the (comment/string-stripped) text. */
export function allBraceRanges(stripped) {
  const stack = [];
  const ranges = [];
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === "{") stack.push(i);
    else if (ch === "}" && stack.length > 0) ranges.push([stack.pop(), i]);
  }
  return ranges;
}

const CONTROL_KEYWORDS = /\b(if|for|while|switch|catch|with)\s*$/;

/** The index of the `(` matching the `)` at `closeIdx`, scanning backward. */
function matchingOpenParen(stripped, closeIdx) {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    const ch = stripped[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The tightest brace range containing `offset` whose opening brace reads as a
 * function/method/arrow BODY rather than an object literal, class body, or
 * control-flow block — recognised by what immediately precedes the `{`:
 *   `)`  a parameter list — UNLESS the matching `(` is itself preceded by
 *        `if`/`for`/`while`/`switch`/`catch`/`with`, which also end in `)`
 *        before `{` but are not a function body (this misfired on
 *        `chat-channels.service.ts`'s `if (!entityType) { await ...assert }`,
 *        resolving to the if-block instead of the method containing it).
 *   `>`  a return-type generic (`): Promise<void> {`) or an arrow (`=> {`) —
 *        without this, a typed async method resolves to its nearest `try`
 *        block instead of its own body, which is what
 *        `assertSeatAvailable(): Promise<void> {` did before this was added.
 * Falls back to the tightest containing range of any kind so a call inside a
 * plain block still resolves to something rather than nothing.
 */
export function enclosingFunctionBody(braceRanges, stripped, offset) {
  const containing = braceRanges
    .filter(([start, end]) => start < offset && offset < end)
    .sort((a, b) => a[1] - a[0] - (b[1] - b[0]));

  for (const [start, end] of containing) {
    let j = start - 1;
    while (j >= 0 && /\s/.test(stripped[j])) j--;
    if (stripped[j] === ")") {
      const openParenAt = matchingOpenParen(stripped, j);
      const before = openParenAt >= 0 ? stripped.slice(Math.max(0, openParenAt - 12), openParenAt) : "";
      if (!CONTROL_KEYWORDS.test(before)) return { start, end };
      continue;
    }
    if (stripped[j] === ">") return { start, end };
  }
  return containing[0] ? { start: containing[0][0], end: containing[0][1] } : null;
}

/** The identifier immediately before the function signature opening `body`. */
export function enclosingFunctionName(stripped, bodyStart) {
  const window = stripped.slice(Math.max(0, bodyStart - 400), bodyStart);
  const re = /([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::[^{=]*)?$/;
  const m = re.exec(window);
  return m ? m[1] : null;
}

// -- cross-file ordering resolution -------------------------------------------

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CALL_SKIP = new Set([
  "if", "for", "while", "switch", "catch", "return", "throw", "new",
  "typeof", "instanceof", "await", "async", "function", "class",
]);

function calledNamesInWindow(win) {
  const names = [];
  const re = /\b([A-Za-z_$][A-Za-z0-9_$]{2,})\s*\(/g;
  let m;
  while ((m = re.exec(win)) !== null)
    if (!CALL_SKIP.has(m[1])) names.push(m[1]);
  return [...new Set(names)];
}

function findFunctionBodyInFile(stripped, name) {
  const pat = new RegExp(
    `(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${escapeRegex(name)}\\s*\\(`,
    "g",
  );
  const m = pat.exec(stripped);
  if (!m) return null;
  const open = stripped.indexOf("{", m.index + m[0].length);
  if (open < 0) return null;
  return balanced(stripped, open);
}

function importedFrom(original, name) {
  const re = /import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(original)) !== null) {
    const parts = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim());
    if (parts.includes(name)) return m[2];
  }
  return null;
}

function resolvedHelperHasInsert(stripped, original, name, filePath) {
  const sameFileBody = findFunctionBodyInFile(stripped, name);
  if (sameFileBody !== null && /\.insert\s*\(/.test(sameFileBody)) return true;
  const specifier = importedFrom(original, name);
  if (!specifier || !specifier.startsWith(".")) return false;
  const abs = join(dirname(join(BACKEND_ROOT, filePath)), specifier) + ".ts";
  let src;
  try { src = readFileSync(abs, "utf8"); } catch { return false; }
  const helperStripped = stripCommentsAndStrings(src);
  const body = findFunctionBodyInFile(helperStripped, name);
  return body !== null && /\.insert\s*\(/.test(body);
}

function tryResolveViaHelper(stripped, original, site, filePath) {
  if (!site.body) return null;
  const afterText = stripped.slice(site.callEnd, site.body.end);
  const beforeText = stripped.slice(site.body.start, site.callOffset);
  for (const name of calledNamesInWindow(afterText)) {
    if (resolvedHelperHasInsert(stripped, original, name, filePath))
      return { verdict: "DIRECT", why: `helper ${name} called after assert contains .insert(` };
  }
  for (const name of calledNamesInWindow(beforeText)) {
    if (resolvedHelperHasInsert(stripped, original, name, filePath))
      return { verdict: "ORDER-VIOLATION", why: `helper ${name} called before assert contains .insert(` };
  }
  return null;
}

function tryResolveViaCallers(stripped, site, functionName) {
  if (!functionName || !site.body) return null;
  const braceRanges = allBraceRanges(stripped);
  const callPat = new RegExp(`\\.${escapeRegex(functionName)}\\s*\\(`, "g");
  let m;
  while ((m = callPat.exec(stripped)) !== null) {
    const callPos = m.index;
    if (callPos >= site.body.start && callPos <= site.body.end) continue;
    const callerBody = enclosingFunctionBody(braceRanges, stripped, callPos);
    if (!callerBody) continue;
    const callEnd = callPos + m[0].length;
    const before = stripped.slice(callerBody.start, callPos);
    const after = stripped.slice(callEnd, callerBody.end);
    if (/\.insert\s*\(/.test(before))
      return { verdict: "ORDER-VIOLATION", why: `caller inserts before calling ${functionName}` };
    if (/\.insert\s*\(/.test(after))
      return { verdict: "DIRECT", why: `caller inserts after calling ${functionName}` };
  }
  return null;
}

// -- call-site discovery -------------------------------------------------------

const ASSERT_CALL_RE = /\.assertWithinLimit\s*\(/g;

/**
 * Every `.assertWithinLimit(...)` call site in one file, with its key and
 * enclosing body. Call sites are LOCATED on `stripped` (comment/string-blind,
 * so a call mentioned only in a comment produces no finding), but the key —
 * a quoted string literal — is read back from `original` at the SAME offset,
 * because `stripCommentsAndStrings` blanks string contents; reading the key
 * off the stripped text would find nothing at all.
 */
export function findAssertCalls(stripped, original, filePath) {
  const braceRanges = allBraceRanges(stripped);
  const results = [];
  let m;
  ASSERT_CALL_RE.lastIndex = 0;
  while ((m = ASSERT_CALL_RE.exec(stripped)) !== null) {
    const openParenAt = m.index + m[0].length - 1;
    const args = balanced(original, openParenAt);
    if (!args) continue;
    const keyMatch = /,\s*["']([A-Za-z][A-Za-z0-9]*)["']/.exec(args);
    if (!keyMatch) continue;

    const body = enclosingFunctionBody(braceRanges, stripped, m.index);
    results.push({
      file: filePath,
      line: lineOf(stripped, m.index),
      key: keyMatch[1],
      callOffset: m.index,
      callEnd: openParenAt + args.length,
      body,
    });
  }
  return results;
}

/**
 * True when `insertRel` sits inside a nested block (an `if`/branch, not the
 * function body itself) that unconditionally `return`s or `throw`s AFTER the
 * insert but before that block closes — i.e. the insert's branch is mutually
 * exclusive with whatever runs after the block, which is exactly the shape
 * `chat-channels.service.ts`'s DIRECT-message branch has: it inserts the DM
 * channel and returns, so that insert can never share a call with the
 * `assertWithinLimit` guarding the GROUP-channel path further down the same
 * method. Textual order is not execution order once an early return is in
 * play, and without this check that branch reads as an ORDER-VIOLATION for
 * code that is in fact correct.
 */
function isGuardedByEarlyReturn(bodyText, insertRel) {
  const ranges = allBraceRanges(bodyText);
  const bodyEnd = bodyText.length - 1;
  const nested = ranges.filter(([s, e]) => s > 0 && e < bodyEnd && s < insertRel && insertRel < e);
  for (const [, e] of nested) if (/\b(return|throw)\b/.test(bodyText.slice(insertRel, e))) return true;
  return false;
}

/** Order classification for one call site against its enclosing body. */
export function classifyOrder(stripped, site) {
  if (!site.body) return { verdict: "DELEGATED", why: "no enclosing function body could be resolved" };
  const { start, end } = site.body;
  const bodyText = stripped.slice(start, end);
  const insertRe = /\.insert\s*\(/g;
  const before = [];
  const after = [];
  let m;
  while ((m = insertRe.exec(bodyText)) !== null) {
    const abs = start + m.index;
    if (abs < site.callOffset) {
      if (!isGuardedByEarlyReturn(bodyText, m.index)) before.push(abs);
    } else if (abs > site.callEnd) after.push(abs);
  }
  if (before.length > 0)
    return {
      verdict: "ORDER-VIOLATION",
      why: `an .insert( at offset ${before[0]} precedes the assertWithinLimit call in the same function body, in a branch that is not mutually exclusive with it`,
    };
  if (after.length > 0) return { verdict: "DIRECT", why: "an .insert( follows the assert in the same function body" };
  return { verdict: "DELEGATED", why: "no .insert( is visible in the enclosing body; the write happens behind a helper this scanner does not follow" };
}

/**
 * Is a `quota:${orgId}:members` advisory lock visible before this call, in
 * the same body? Checked against `original`, not `stripped` — the literal
 * lock key lives inside a template literal, and template contents are
 * blanked by `stripCommentsAndStrings` the same as any other string.
 */
export function classifyMembersLock(original, site) {
  if (site.key !== MEMBERS_KEY) return null;
  if (!site.body) return { verdict: "LOCK-MISSING", why: "no enclosing function body could be resolved" };
  const before = original.slice(site.body.start, site.callOffset);
  const locked = LOCK_MARKERS.some((marker) => before.includes(marker));
  return locked
    ? { verdict: "LOCK-OK", why: "a members quota advisory lock precedes the assert in the same body" }
    : { verdict: "LOCK-MISSING", why: "no quota:${orgId}:members advisory lock precedes the assert in the same body" };
}

/**
 * Inverse check: for each (table, key) pair in the map, find every
 * `.insert(TABLE)` call in `stripped` and verify that an
 * `assertWithinLimit(_, "KEY", ...)` appears BEFORE it in the same enclosing
 * function body.  Returns sites where no such assert is found — these are
 * inserts that bypass the quota gate entirely.
 *
 * "Before" is textual: if the assert's call offset is less than the insert's
 * offset within the same body, the ordering rule is satisfied.  A conditional
 * assert (inside an if-block that also contains the insert) satisfies this
 * rule because the enclosing function body contains both, and the assert
 * appears earlier in the source.
 */
export function findUncoveredTableInserts(stripped, original, filePath, tableKeyMap) {
  const braceRanges = allBraceRanges(stripped);
  const results = [];

  for (const { table, key } of tableKeyMap) {
    const insertRe = new RegExp(`\\.insert\\s*\\(\\s*${table}\\s*\\)`, "g");
    let m;
    while ((m = insertRe.exec(stripped)) !== null) {
      const insertOffset = m.index;
      const body = enclosingFunctionBody(braceRanges, stripped, insertOffset);
      if (!body) continue;

      const bodyBeforeInsert = stripped.slice(body.start, insertOffset);

      let covered = false;
      const assertRe = /\.assertWithinLimit\s*\(/g;
      let am;
      while ((am = assertRe.exec(bodyBeforeInsert)) !== null) {
        const absoluteOpenParen = body.start + am.index + am[0].length - 1;
        const args = balanced(original, absoluteOpenParen);
        if (!args) continue;
        const keyMatch = /,\s*["']([A-Za-z][A-Za-z0-9]*)["']/.exec(args);
        if (keyMatch && keyMatch[1] === key) {
          covered = true;
          break;
        }
      }

      if (!covered) {
        results.push({
          file: filePath,
          line: lineOf(stripped, insertOffset),
          table,
          key,
        });
      }
    }
  }
  return results;
}

// -- repository walk ------------------------------------------------------------

function walkTs(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walkTs(full, out);
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".spec.ts") &&
      !entry.endsWith(".e2e-spec.ts") &&
      !entry.endsWith(".test.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function scan() {
  const keys = parseLimitKeys(readFileSync(CONSTANTS_FILE, "utf8"));
  const files = walkTs(SRC);

  const sites = [];
  const uncoveredInserts = [];
  let candidatesInsertCount = 0;

  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const hasAssert = source.includes("assertWithinLimit");
    const hasTableInsert = TABLE_KEY_MAP.some(({ table }) => source.includes(table));
    if (!hasAssert && !hasTableInsert) continue;

    const stripped = stripCommentsAndStrings(source);
    const rel = relative(BACKEND_ROOT, file).replace(/\\/g, "/");

    if (hasAssert) {
      for (const site of findAssertCalls(stripped, source, rel)) {
        const name = site.body ? enclosingFunctionName(stripped, site.body.start) : null;
        let order = classifyOrder(stripped, site);
        if (order.verdict === "DELEGATED" && site.body) {
          if (site.key === MEMBERS_KEY) {
            const via = tryResolveViaCallers(stripped, site, name);
            if (via) order = via;
          }
          if (order.verdict === "DELEGATED") {
            const via = tryResolveViaHelper(stripped, source, site, rel);
            if (via) order = via;
          }
        }
        const lock = classifyMembersLock(source, site);
        sites.push({ ...site, order, lock, enclosingFunction: name });
      }
    }

    if (hasTableInsert) {
      for (const { table } of TABLE_KEY_MAP) {
        const countRe = new RegExp(`\\.insert\\s*\\(\\s*${table}\\s*\\)`, "g");
        const matches = stripped.match(countRe);
        if (table === "candidates" && matches) candidatesInsertCount += matches.length;
      }
      if (!rel.startsWith("src/scripts/")) {
        for (const finding of findUncoveredTableInserts(stripped, source, rel, TABLE_KEY_MAP)) {
          uncoveredInserts.push(finding);
        }
      }
    }
  }

  return { keys, files, sites, uncoveredInserts, candidatesInsertCount };
}

// -- self-test --------------------------------------------------------------

function runSelfTest() {
  let passed = 0;
  const failures = [];
  const assert = (label, condition) => {
    if (condition) passed++;
    else failures.push(label);
  };

  const constFixture = `
export type PlanTier = "FREE" | "PAID";

export type LimitKey =
  | "members"
  | "projects"
  | "kbPages";

export const PLAN_LIMITS = {};
`;
  const parsedKeys = parseLimitKeys(constFixture);
  assert("parses the LimitKey union from source", parsedKeys.length === 3);
  assert("keys are extracted in declared order", parsedKeys.join(",") === "members,projects,kbPages");
  assert(
    "a fixture with no LimitKey union parses to an empty list, not a crash",
    parseLimitKeys("export const x = 1;").length === 0,
  );

  const directFixture = `
class Svc {
  async create(orgId) {
    await this.planLimits.assertWithinLimit(orgId, "projects");
    const [row] = await this.db.insert(projects).values({ orgId }).returning();
    return row;
  }
}
`;
  const strippedDirect = stripCommentsAndStrings(directFixture);
  const directSites = findAssertCalls(strippedDirect, directFixture, "fixture.ts");
  assert("finds a single-line call site", directSites.length === 1);
  assert("extracts its key", directSites[0]?.key === "projects");
  assert(
    "an insert AFTER the assert in the same body is DIRECT",
    classifyOrder(strippedDirect, directSites[0]).verdict === "DIRECT",
  );

  const multilineFixture = `
class Svc {
  async importLeads(orgId, input) {
    await this.planLimits.assertWithinLimit(
      orgId,
      "crmLeads",
      input.leads.length,
    );
    await this.db.insert(leads).values(input.leads);
  }
}
`;
  const strippedMultiline = stripCommentsAndStrings(multilineFixture);
  const multilineSites = findAssertCalls(strippedMultiline, multilineFixture, "fixture.ts");
  assert("finds a call whose arguments span multiple lines", multilineSites.length === 1);
  assert("extracts the key from a multi-line argument list", multilineSites[0]?.key === "crmLeads");
  assert(
    "a multi-line call is still classified DIRECT",
    classifyOrder(strippedMultiline, multilineSites[0]).verdict === "DIRECT",
  );

  const violationFixture = `
class Svc {
  async create(orgId) {
    const [row] = await this.db.insert(projects).values({ orgId }).returning();
    await this.planLimits.assertWithinLimit(orgId, "projects");
    return row;
  }
}
`;
  const strippedViolation = stripCommentsAndStrings(violationFixture);
  const violationSites = findAssertCalls(strippedViolation, violationFixture, "fixture.ts");
  assert(
    "an insert BEFORE the assert in the same body is ORDER-VIOLATION",
    classifyOrder(strippedViolation, violationSites[0]).verdict === "ORDER-VIOLATION",
  );

  const earlyReturnBranchFixture = `
class Svc {
  async createChannel(orgId, kind) {
    if (kind === "DIRECT") {
      const [created] = await this.db.insert(chatChannels).values({ orgId }).returning();
      return { channel: created, created: true };
    }
    await this.planLimits.assertWithinLimit(orgId, "chatChannels");
    const [row] = await this.db.insert(chatChannels).values({ orgId }).returning();
    return { channel: row, created: true };
  }
}
`;
  const strippedEarlyReturn = stripCommentsAndStrings(earlyReturnBranchFixture);
  const earlyReturnSites = findAssertCalls(strippedEarlyReturn, earlyReturnBranchFixture, "fixture.ts");
  assert(
    "an insert in an earlier, mutually-exclusive if-branch that returns is NOT a violation — chat-channels.service.ts's real shape",
    classifyOrder(strippedEarlyReturn, earlyReturnSites[0]).verdict === "DIRECT",
  );

  const delegatedFixture = `
class Svc {
  async create(orgId, input) {
    await this.planLimits.assertWithinLimit(orgId, "crmContacts");
    return createMirroredContact(this.db, orgId, input);
  }
}
`;
  const strippedDelegated = stripCommentsAndStrings(delegatedFixture);
  const delegatedSites = findAssertCalls(strippedDelegated, delegatedFixture, "fixture.ts");
  assert(
    "no insert visible in the enclosing body is DELEGATED, not a silent pass",
    classifyOrder(strippedDelegated, delegatedSites[0]).verdict === "DELEGATED",
  );

  const ifGuardedFixture = `
class Svc {
  async create(orgId, entityType) {
    if (!entityType) {
      await this.planLimits.assertWithinLimit(orgId, "chatChannels");
    }
    const channel = await this.db.transaction(async (tx) => {
      const [created] = await tx.insert(chatChannels).values({ orgId }).returning();
      return created;
    });
    return channel;
  }
}
`;
  const strippedIfGuarded = stripCommentsAndStrings(ifGuardedFixture);
  const ifGuardedSites = findAssertCalls(strippedIfGuarded, ifGuardedFixture, "fixture.ts");
  assert(
    "an assert guarded by a plain if() resolves to the METHOD body, not the if-block — chat-channels.service.ts's real shape",
    ifGuardedSites[0]?.body && strippedIfGuarded.slice(ifGuardedSites[0].body.start, ifGuardedSites[0].body.end).includes(".insert(chatChannels)"),
  );
  assert(
    "with the method body correctly resolved, the later insert is found and this is DIRECT",
    classifyOrder(strippedIfGuarded, ifGuardedSites[0]).verdict === "DIRECT",
  );

  const lockOkFixture = `
class Svc {
  private async reserveMemberSeat(tx, orgId) {
    await tx.execute(lockMembersQuota(orgId));
    await this.planLimits.assertWithinLimit(orgId, "members", 1, tx);
  }
}
`;
  const strippedLockOk = stripCommentsAndStrings(lockOkFixture);
  const lockOkSites = findAssertCalls(strippedLockOk, lockOkFixture, "fixture.ts");
  assert(
    "a members call preceded by lockMembersQuota( in the same body is LOCK-OK",
    classifyMembersLock(lockOkFixture, lockOkSites[0])?.verdict === "LOCK-OK",
  );

  const lockMissingFixture = `
class Svc {
  private async reserveMemberSeat(tx, orgId) {
    await this.planLimits.assertWithinLimit(orgId, "members", 1, tx);
  }
}
`;
  const strippedLockMissing = stripCommentsAndStrings(lockMissingFixture);
  const lockMissingSites = findAssertCalls(strippedLockMissing, lockMissingFixture, "fixture.ts");
  assert(
    "a members call with no advisory lock in reach is LOCK-MISSING — this is the finding the gate must catch",
    classifyMembersLock(lockMissingFixture, lockMissingSites[0])?.verdict === "LOCK-MISSING",
  );

  const nonMembersFixture = `
class Svc {
  async create(orgId) {
    await this.planLimits.assertWithinLimit(orgId, "projects");
  }
}
`;
  const strippedNonMembers = stripCommentsAndStrings(nonMembersFixture);
  const nonMembersSites = findAssertCalls(strippedNonMembers, nonMembersFixture, "fixture.ts");
  assert(
    "the members lock check does not apply to a non-members key",
    classifyMembersLock(nonMembersFixture, nonMembersSites[0]) === null,
  );

  const coveredInsertFixture = `
class Svc {
  async create(orgId) {
    await this.planLimits.assertWithinLimit(orgId, "hrCandidates", 1);
    const [row] = await this.db.insert(candidates).values({ orgId }).returning();
    return row;
  }
}
`;
  const strippedCovered = stripCommentsAndStrings(coveredInsertFixture);
  const coveredFindings = findUncoveredTableInserts(strippedCovered, coveredInsertFixture, "fixture.ts", [{ table: "candidates", key: "hrCandidates" }]);
  assert("a covered .insert(candidates) preceded by assertWithinLimit(hrCandidates) produces no finding", coveredFindings.length === 0);

  const uncoveredInsertFixture = `
class Svc {
  async create(orgId) {
    const [row] = await this.db.insert(candidates).values({ orgId }).returning();
    return row;
  }
}
`;
  const strippedUncovered = stripCommentsAndStrings(uncoveredInsertFixture);
  const uncoveredFindings = findUncoveredTableInserts(strippedUncovered, uncoveredInsertFixture, "fixture.ts", [{ table: "candidates", key: "hrCandidates" }]);
  assert("an .insert(candidates) with NO assertWithinLimit before it produces one UNCOVERED-INSERT finding", uncoveredFindings.length === 1);
  assert("the UNCOVERED-INSERT finding names the correct table and key", uncoveredFindings[0]?.table === "candidates" && uncoveredFindings[0]?.key === "hrCandidates");

  const wrongKeyFixture = `
class Svc {
  async create(orgId) {
    await this.planLimits.assertWithinLimit(orgId, "crmLeads", 1);
    const [row] = await this.db.insert(candidates).values({ orgId }).returning();
    return row;
  }
}
`;
  const strippedWrongKey = stripCommentsAndStrings(wrongKeyFixture);
  const wrongKeyFindings = findUncoveredTableInserts(strippedWrongKey, wrongKeyFixture, "fixture.ts", [{ table: "candidates", key: "hrCandidates" }]);
  assert("assertWithinLimit with a DIFFERENT key does not satisfy the candidates coverage requirement", wrongKeyFindings.length === 1);

  const conditionalAssertFixture = `
class Svc {
  async create(orgId, existing) {
    if (!existing) {
      await this.planLimits.assertWithinLimit(orgId, "hrCandidates", 1);
      const [row] = await this.db.insert(candidates).values({ orgId }).returning();
      return row;
    }
    return existing;
  }
}
`;
  const strippedConditional = stripCommentsAndStrings(conditionalAssertFixture);
  const conditionalFindings = findUncoveredTableInserts(strippedConditional, conditionalAssertFixture, "fixture.ts", [{ table: "candidates", key: "hrCandidates" }]);
  assert("a conditional assert (in an if-block) before the insert in the SAME function body satisfies coverage", conditionalFindings.length === 0);

  const patternADirectFixture = `
class Svc {
  private async reserveSeat(tx, orgId) {
    await tx.execute(lockMembersQuota(orgId));
    await this.planLimits.assertWithinLimit(orgId, "members", 1, tx);
  }
  async createMember(tx, orgId) {
    await this.reserveSeat(tx, orgId);
    const [row] = await tx.insert(organizationMembers).values({}).returning();
    return row;
  }
}
`;
  const strippedPatA = stripCommentsAndStrings(patternADirectFixture);
  const patASites = findAssertCalls(strippedPatA, patternADirectFixture, "fixture.ts");
  const patAName = patASites[0]?.body ? enclosingFunctionName(strippedPatA, patASites[0].body.start) : null;
  assert("Pattern A: base classifier sees DELEGATED for assert-in-helper when no insert in helper body", classifyOrder(strippedPatA, patASites[0]).verdict === "DELEGATED");
  assert("Pattern A: caller inserts after helper call → tryResolveViaCallers returns DIRECT", tryResolveViaCallers(strippedPatA, patASites[0], patAName)?.verdict === "DIRECT");

  const patternAViolationFixture = `
class Svc {
  private async reserveSeat(tx, orgId) {
    await tx.execute(lockMembersQuota(orgId));
    await this.planLimits.assertWithinLimit(orgId, "members", 1, tx);
  }
  async createMember(tx, orgId) {
    const [row] = await tx.insert(organizationMembers).values({}).returning();
    await this.reserveSeat(tx, orgId);
    return row;
  }
}
`;
  const strippedPatAV = stripCommentsAndStrings(patternAViolationFixture);
  const patAVSites = findAssertCalls(strippedPatAV, patternAViolationFixture, "fixture.ts");
  const patAVName = patAVSites[0]?.body ? enclosingFunctionName(strippedPatAV, patAVSites[0].body.start) : null;
  assert("Pattern A: caller inserts BEFORE helper call → tryResolveViaCallers returns ORDER-VIOLATION", tryResolveViaCallers(strippedPatAV, patAVSites[0], patAVName)?.verdict === "ORDER-VIOLATION");

  const patternBDirectFixture = `
async function insertRecord(tx, orgId, data) {
  const [row] = await tx.insert(tickets).values({ orgId }).returning();
  return row;
}
class Svc {
  async create(orgId, input) {
    await this.planLimits.assertWithinLimit(orgId, "supportTickets");
    return insertRecord(this.db, orgId, input);
  }
}
`;
  const strippedPatB = stripCommentsAndStrings(patternBDirectFixture);
  const patBSites = findAssertCalls(strippedPatB, patternBDirectFixture, "fixture.ts");
  assert("Pattern B: base classifier sees DELEGATED when insert is in a same-file helper", classifyOrder(strippedPatB, patBSites[0]).verdict === "DELEGATED");
  assert("Pattern B: same-file helper with .insert called after assert → tryResolveViaHelper returns DIRECT", tryResolveViaHelper(strippedPatB, patternBDirectFixture, patBSites[0], "fixture.ts")?.verdict === "DIRECT");

  const patternBViolationFixture = `
async function insertRecord(tx, orgId, data) {
  const [row] = await tx.insert(tickets).values({ orgId }).returning();
  return row;
}
class Svc {
  async create(orgId, input) {
    const result = await insertRecord(this.db, orgId, input);
    await this.planLimits.assertWithinLimit(orgId, "supportTickets");
    return result;
  }
}
`;
  const strippedPatBV = stripCommentsAndStrings(patternBViolationFixture);
  const patBVSites = findAssertCalls(strippedPatBV, patternBViolationFixture, "fixture.ts");
  assert("Pattern B: same-file helper with .insert called BEFORE assert → tryResolveViaHelper returns ORDER-VIOLATION", tryResolveViaHelper(strippedPatBV, patternBViolationFixture, patBVSites[0], "fixture.ts")?.verdict === "ORDER-VIOLATION");

  // -- the real repository, so a parser/regex change that empties the scan fails here --
  const real = scan();
  assert(`the real constants file parses at least ${MIN_KEYS} keys (found ${real.keys.length})`, real.keys.length >= MIN_KEYS);
  assert(`at least ${MIN_SCANNED_FILES} source files are scanned (found ${real.files.length})`, real.files.length >= MIN_SCANNED_FILES);
  assert(`at least ${MIN_CALL_SITES} call sites are found (found ${real.sites.length})`, real.sites.length >= MIN_CALL_SITES);

  const keysWithSites = new Set(real.sites.map((s) => s.key));
  const missing = real.keys.filter((k) => !keysWithSites.has(k));
  assert(
    `every derived key has at least one call site in the real corpus (missing: ${missing.join(", ") || "none"})`,
    missing.length === 0,
  );

  const memberSites = real.sites.filter((s) => s.key === MEMBERS_KEY);
  assert("the real corpus has members call sites to check the lock on", memberSites.length > 0);
  const lockMissingReal = memberSites.filter((s) => s.lock?.verdict === "LOCK-MISSING");
  assert(
    `every real "members" call site carries the quota advisory lock (${lockMissingReal.length} missing)`,
    lockMissingReal.length === 0,
  );

  const violationsReal = real.sites.filter((s) => s.order.verdict === "ORDER-VIOLATION");
  assert(`no real call site has the insert before the assert (${violationsReal.length} found)`, violationsReal.length === 0);

  const directReal = real.sites.filter((s) => s.order.verdict === "DIRECT").length;
  assert(
    "at least some real call sites resolve to DIRECT ordering — proof the classifier isn't vacuously DELEGATED on everything",
    directReal > 0,
  );

  const IN_SCOPE_SUFFIXES = [
    "hr/directory/employee-onboarding.service.ts",
    "organization/core/invitation-acceptance.service.ts",
    "support/core/support-tickets.service.ts",
  ];
  const stillDelegated = real.sites.filter(
    (s) => s.order.verdict === "DELEGATED" && IN_SCOPE_SUFFIXES.some((suf) => s.file.replace(/\\/g, "/").endsWith(suf)),
  );
  assert(
    `the three in-scope DELEGATED sites (employee-onboarding, invitation-acceptance, support-tickets) are now DIRECT — ${stillDelegated.length} still DELEGATED`,
    stillDelegated.length === 0,
  );

  assert(
    `the real corpus has at least ${MIN_CANDIDATES_INSERTS} .insert(candidates) sites — anti-vacuity for the inverse check (found ${real.candidatesInsertCount})`,
    real.candidatesInsertCount >= MIN_CANDIDATES_INSERTS,
  );

  assert(
    `every real .insert(candidates) site is preceded by assertWithinLimit("hrCandidates", ...) — no gaps allowed (${real.uncoveredInserts.length} uncovered)`,
    real.uncoveredInserts.length === 0,
  );

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error(`check-plan-limit-enforcement self-tests: ${failures.length} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`check-plan-limit-enforcement self-tests: ${passed} passed`);
  process.exit(0);
}

if (SELF_TEST) runSelfTest();

// -- main ---------------------------------------------------------------------

const { keys, files, sites, uncoveredInserts, candidatesInsertCount } = scan();

console.log(`LimitKey union: ${keys.length} keys  ·  source files scanned ${files.length}  ·  assertWithinLimit call sites ${sites.length}  ·  .insert(candidates) sites ${candidatesInsertCount}`);

if (keys.length < MIN_KEYS || files.length < MIN_SCANNED_FILES || sites.length < MIN_CALL_SITES) {
  console.error(
    `\nINCONCLUSIVE — parsed ${keys.length} keys (floor ${MIN_KEYS}), scanned ${files.length} files (floor ${MIN_SCANNED_FILES}), found ${sites.length} call sites (floor ${MIN_CALL_SITES}). The scan is broken; a clean result would prove nothing.`,
  );
  process.exit(2);
}

const byKey = new Map();
for (const key of keys) byKey.set(key, []);
for (const site of sites) {
  if (!byKey.has(site.key)) byKey.set(site.key, []);
  byKey.get(site.key).push(site);
}

const missingKeys = keys.filter((k) => (byKey.get(k) ?? []).length === 0);
const violations = sites.filter((s) => s.order.verdict === "ORDER-VIOLATION");
const lockMissing = sites.filter((s) => s.lock?.verdict === "LOCK-MISSING");
const delegated = sites.filter((s) => s.order.verdict === "DELEGATED");
const direct = sites.filter((s) => s.order.verdict === "DIRECT");

console.log("\n-- per-key coverage --");
for (const key of keys) {
  const keySites = byKey.get(key) ?? [];
  const directCount = keySites.filter((s) => s.order.verdict === "DIRECT").length;
  const delegatedCount = keySites.filter((s) => s.order.verdict === "DELEGATED").length;
  const status = keySites.length === 0 ? "MISSING" : "PROVEN";
  console.log(
    `  ${key.padEnd(16)} ${status.padEnd(8)} sites=${keySites.length}  direct=${directCount}  delegated-unverified=${delegatedCount}`,
  );
}

console.log(
  `\nOrdering: ${direct.length} DIRECT (statically proven) · ${delegated.length} DELEGATED (call proven, order unverified — written behind a cross-file helper) · ${violations.length} ORDER-VIOLATION`,
);
console.log(`Members advisory lock: ${sites.filter((s) => s.key === MEMBERS_KEY).length} sites, ${lockMissing.length} missing the lock`);

if (LIST) {
  console.log("\n-- every call site --");
  for (const s of sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    const lockNote = s.lock ? `  ${s.lock.verdict}` : "";
    console.log(`  ${s.file}:${s.line}  key=${s.key}  fn=${s.enclosingFunction ?? "?"}  ${s.order.verdict}${lockNote}`);
  }
  process.exit(0);
}

let failed = false;

if (missingKeys.length > 0) {
  console.error(`\nFAIL — ${missingKeys.length} LimitKey(s) with ZERO assertWithinLimit call sites anywhere in src: ${missingKeys.join(", ")}.`);
  console.error("A key with no call site means that resource's creation path enforces no quota at all.");
  failed = true;
}

if (violations.length > 0) {
  console.error(`\nFAIL — ${violations.length} call site(s) where an .insert( precedes the assertWithinLimit call in the same function body:`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  key=${v.key}  ${v.order.why}`);
  failed = true;
}

if (lockMissing.length > 0) {
  console.error(`\nFAIL — ${lockMissing.length} "members" call site(s) with no quota:\${orgId}:members advisory lock in reach:`);
  for (const l of lockMissing) console.error(`  ${l.file}:${l.line}  ${l.lock.why}`);
  failed = true;
}

if (candidatesInsertCount < MIN_CANDIDATES_INSERTS) {
  console.error(
    `\nINCONCLUSIVE — found only ${candidatesInsertCount} .insert(candidates) site(s) in the corpus (floor ${MIN_CANDIDATES_INSERTS}). The inverse check is vacuous; a clean result would prove nothing.`,
  );
  failed = true;
}

if (uncoveredInserts.length > 0) {
  console.error(`\nFAIL — ${uncoveredInserts.length} .insert(candidates) site(s) with no assertWithinLimit("hrCandidates", ...) before them in the same function body:`);
  for (const u of uncoveredInserts) console.error(`  ${u.file}:${u.line}  table=${u.table}  expected-key=${u.key}`);
  console.error("Each of these is a quota enforcement gap: a candidate insert that runs without checking the plan limit first.");
  failed = true;
}

if (failed) process.exit(1);

console.log(
  `\nOK — all ${keys.length} keys have at least one call site, no insert precedes its assert, every members site carries the quota lock, and all ${candidatesInsertCount} .insert(candidates) site(s) are preceded by assertWithinLimit("hrCandidates", ...).`,
);
console.log(
  `${delegated.length} call site(s) are DELEGATED — the write is not visible in the enclosing body (a cross-file helper). These are NOT proven ordered and are not counted as a pass; run with --list to review them.`,
);
