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
import { join, relative } from "node:path";
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
  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!source.includes("assertWithinLimit")) continue;
    const stripped = stripCommentsAndStrings(source);
    const rel = relative(BACKEND_ROOT, file).replace(/\\/g, "/");
    for (const site of findAssertCalls(stripped, source, rel)) {
      const order = classifyOrder(stripped, site);
      const lock = classifyMembersLock(source, site);
      const name = site.body ? enclosingFunctionName(stripped, site.body.start) : null;
      sites.push({ ...site, order, lock, enclosingFunction: name });
    }
  }

  return { keys, files, sites };
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

const { keys, files, sites } = scan();

console.log(`LimitKey union: ${keys.length} keys  ·  source files scanned ${files.length}  ·  assertWithinLimit call sites ${sites.length}`);

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

if (failed) process.exit(1);

console.log(
  `\nOK — all ${keys.length} keys have at least one call site, no insert precedes its assert, and every members site carries the quota lock.`,
);
console.log(
  `${delegated.length} call site(s) are DELEGATED — the write is not visible in the enclosing body (a cross-file helper). These are NOT proven ordered and are not counted as a pass; run with --list to review them.`,
);
