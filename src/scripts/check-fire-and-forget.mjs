#!/usr/bin/env node
/**
 * Gate: fire-and-forget side effects.
 *
 * TWO TIERS, BECAUSE THEY ANSWER DIFFERENT QUESTIONS
 * --------------------------------------------------
 * TIER 1 — BANNED, zero tolerance. Discarding the promise of a notification dispatch or a mail
 * sync checkpoint loses the effect outright on a crash between the domain write and the delivery.
 * These are always a bug; the gate fails on the first one.
 *
 * TIER 2 — RATCHETED. Every other discarded promise (`void x.y(`) and every swallowed rejection
 * (`.catch(() => undefined)` and friends) across the whole of `src`. Most of these are deliberate;
 * some are the next `build.ticket.status_changed`. They cannot be banned outright today, so the
 * gate pins the number and fails when it grows.
 *
 * WHY THE PREVIOUS VERSION DID NOT HOLD
 * -------------------------------------
 * It covered exactly two method names (`emit`, `savePosition`) inside `src/modules`, and then
 * PRINTED a list of ~39 uncovered method names and exited 0. A gate that reports findings and
 * exits 0 teaches its readers to scroll past it, which is worse than not reporting them: the
 * output looked like diligence while the number was free to climb. Coverage is now every shape the
 * scanner can see, and the number is pinned instead of printed.
 *
 * WHAT THIS GATE STILL CANNOT SEE — stated so a green run is not read as more than it is:
 *   · an async function called with neither `await` nor `void` (needs type information);
 *   · `.then()` with no rejection handler;
 *   · a `catch` block whose body only logs — `org-setup.service.ts` hid four steps of org
 *     provisioning behind exactly that, and no regex distinguishes it from a legitimate one.
 * `registerAfterCommit` is inventoried below but deliberately NOT ratcheted: backend/CLAUDE.md §4
 * names it one of the three sanctioned mechanisms for a side effect, so its call count is a
 * measure of adoption, not of debt.
 *
 * TIER 1 SCANS CODE ONLY — comments and string bodies are blanked first (see
 * `blankCommentsAndStrings`), because a ban whose only finding is prose cannot be cleared by
 * writing correct code. TIER 2 still counts the raw source: it is a ratchet, and its constant was
 * measured on that basis against `git archive HEAD`, so re-basing the measurement is a separate
 * change that has to re-measure the pin rather than inherit it.
 *
 * Usage:
 *   node src/scripts/check-fire-and-forget.mjs
 *   node src/scripts/check-fire-and-forget.mjs --self-test
 */

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");

const SKIP_DIRS = ["node_modules", "dist", "__tests__", "scripts", "migrations"];

const MIN_FILES = 1500;

/**
 * TIER 2 RATCHET — the measured count of floating promises and swallowed rejections in `src`.
 *
 * RE-MEASURED 2026-09-03 (ticket 35, box 5) at 279 across 3,605 scanned files: 198 `void x.y(`
 * floating promises and 81 swallowed `.catch()` rejections. Measured HERMETICALLY against
 * `git archive HEAD src test` — not the shared working tree — so the number this gate holds is the
 * committed one CI will see, not another agent's in-flight work. The gate had been reporting
 * "TIER 2 IMPROVED — 4 fewer than the ratchet" on every run since the 4 sites left; four sites of
 * slack is four regressions a future change may land for free, which is the same defect as a
 * baseline raised to go green, only pointing the other way. It is not a target and not an approval
 * of those 279 call sites. Lower it whenever the real count drops — the gate says so on every run
 * that comes in under it.
 */
const TIER2_RATCHET = 279;

// --- TIER 1: banned shapes -------------------------------------------------
const VOID_EMIT_RE = /\bvoid\s+(?:this\.\w+\s*\.\s*emit|[\w.]+\s*\.\s*emit)\s*\(/;
const VOID_SAVE_POSITION_RE =
  /\bvoid\s+(?:this\.\w+\s*\.\s*savePosition|[\w.]+\s*\.\s*savePosition)\s*\(/;
const DISPATCH_SIGNAL_RE = /\b(?:eventKey|targetUserIds|NotificationDispatchService)\b/;

// --- TIER 2: ratcheted shapes ---------------------------------------------
const FLOATING_RE = /\bvoid\s+(?:await\s+)?(?:this\s*\.\s*)?[\w$]+(?:\s*\.\s*[\w$]+)*\s*\(/g;
const SWALLOWED_RE =
  /\.catch\s*\(\s*(?:\(\s*\)|\w+|\(\s*\w+(?:\s*:\s*[\w<>[\]|\s]+)?\s*\))\s*=>\s*(?:undefined|null|void 0|\{\s*\})\s*\)/g;
const SWALLOWED_NOOP_RE = /\.catch\s*\(\s*(?:noop|NOOP)\s*\)/g;
const AFTER_COMMIT_RE = /\bregisterAfterCommit\s*\(/g;

/** The trailing method name of a `void a.b.c(` expression, for grouping the report. */
function floatingMethodName(match) {
  const stripped = match.replace(/\s+/g, "").replace(/^void(await)?/, "").replace(/\($/, "");
  const parts = stripped.split(".");
  return parts[parts.length - 1] || stripped;
}

export function floatingPromises(source) {
  FLOATING_RE.lastIndex = 0;
  return [...source.matchAll(FLOATING_RE)].map((m) => ({
    method: floatingMethodName(m[0]),
    index: m.index,
  }));
}

export function swallowedRejections(source) {
  SWALLOWED_RE.lastIndex = 0;
  SWALLOWED_NOOP_RE.lastIndex = 0;
  return [...source.matchAll(SWALLOWED_RE), ...source.matchAll(SWALLOWED_NOOP_RE)].map((m) => ({
    text: m[0].trim(),
    index: m.index,
  }));
}

export function afterCommitCalls(source) {
  AFTER_COMMIT_RE.lastIndex = 0;
  return [...source.matchAll(AFTER_COMMIT_RE)].length;
}

/**
 * Blanks comment bodies, keeping every newline so line numbers still line up with the file.
 *
 * Tier 1 is a BAN, so a false positive there is not a nuisance, it is a gate that cannot be made
 * green by writing correct code. `crm/automation-studio/crm-automation-bus.service.ts:37` is the
 * worked example: the doc comment on `emit` explains the outage it was written to fix and QUOTES
 * the shape — "Callers fire this detached — `void this.bus.emit(...)`" — which the line scanner
 * then read as a call, with `eventKey` appearing 20 lines below in a real `where` clause to
 * satisfy the dispatch-signal window. The prose describing the fix was the only violation.
 *
 * String bodies are blanked with it: a quote is what makes `//` inside `"http://x"` not a comment,
 * so the two cannot be separated, and tier 1 looks for a call expression which never lives inside
 * a string literal anyway.
 */
export function blankCommentsAndStrings(src) {
  const out = [];
  let i = 0;
  let inBlock = false;
  let inString = null;

  while (i < src.length) {
    const ch = src[i];

    if (inBlock) {
      if (ch === "*" && src[i + 1] === "/") {
        out.push("  ");
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
        out.push("  ");
        i += 2;
        continue;
      }
      if (ch === inString) {
        out.push(" ");
        inString = null;
        i++;
        continue;
      }
      out.push(ch === "\n" ? "\n" : " ");
      i++;
      continue;
    }

    if (ch === "/" && src[i + 1] === "*") {
      out.push("  ");
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

/** Tier 1 only: the shapes that are banned outright. */
export function scanFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const src = blankCommentsAndStrings(raw);
  const lines = src.split("\n");
  const rawLines = raw.split("\n");
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (VOID_EMIT_RE.test(line)) {
      const window = lines.slice(i, Math.min(i + 20, lines.length)).join("\n");
      if (DISPATCH_SIGNAL_RE.test(window))
        violations.push({ line: i + 1, text: (rawLines[i] ?? "").trim() });
    }
    if (VOID_SAVE_POSITION_RE.test(line))
      violations.push({ line: i + 1, text: (rawLines[i] ?? "").trim() });
  }
  return violations;
}

/**
 * The ratchet comparison. `improved` is reported rather than failed: several agents work this tree
 * concurrently, so failing a run for being BETTER than the pin would turn a real improvement into
 * someone else's red build. It is still called out on every run so the pin cannot quietly rot.
 */
export function verdict(count, ratchet) {
  if (count > ratchet) return "REGRESSION";
  if (count < ratchet) return "IMPROVED";
  return "AT_RATCHET";
}

function collectFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.includes(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) files.push(...collectFiles(full));
    else if (
      stat.isFile() &&
      extname(entry) === ".ts" &&
      !entry.endsWith(".spec.ts") &&
      !entry.endsWith(".d.ts")
    )
      files.push(full);
  }
  return files;
}

function runSelfTest() {
  const dir = join(tmpdir(), "check-fire-and-forget-self-test");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}

  let passed = 0;
  const failures = [];
  const assert = (label, condition) => {
    if (condition) passed++;
    else failures.push(label);
  };

  const write = (name, lines) => {
    const p = join(dir, name);
    writeFileSync(p, lines.join("\n"));
    return p;
  };

  // --- Tier 1 ---
  const badFile = write("bad.service.ts", [
    "@Injectable()",
    "export class BadService {",
    "  async doWork(orgId: string) {",
    "    void this.dispatch.emit({",
    "      eventKey: 'some.event',",
    "      orgId,",
    "      targetUserIds: ['user-1'],",
    "    }).catch(console.error);",
    "  }",
    "}",
  ]);
  const goodFile = write("good.service.ts", [
    "@Injectable()",
    "export class GoodService {",
    "  async doWork(orgId: string) {",
    "    await this.dispatch.emit({",
    "      eventKey: 'some.event',",
    "      orgId,",
    "      targetUserIds: ['user-1'],",
    "    });",
    "  }",
    "}",
  ]);
  const badCheckpointFile = write("bad-checkpoint.service.ts", [
    "export class BadCheckpointService {",
    "  async doWork(orgId: string) {",
    "    void this.checkpoints.savePosition(orgId, 1, 'INBOX', null);",
    "  }",
    "}",
  ]);
  const goodCheckpointFile = write("good-checkpoint.service.ts", [
    "export class GoodCheckpointService {",
    "  async doWork(orgId: string) {",
    "    await this.checkpoints.savePosition(orgId, 1, 'INBOX', null);",
    "  }",
    "}",
  ]);

  // The shape of the false positive this gate carried: a doc comment that quotes the banned call
  // while explaining the outage it caused, with a real `eventKey` reference inside the window.
  const documentedFile = write("documented.service.ts", [
    "export class DocumentedService {",
    "  /**",
    "   * Callers fire this detached — `void this.bus.emit(...)` in deals.service — so it opens",
    "   * a transaction of its own rather than inheriting the request's committed one.",
    "   */",
    "  async emit(orgId: string, eventKey: string) {",
    "    await this.tx.run(orgId, eventKey);",
    "    // void this.checkpoints.savePosition(orgId, 1, 'INBOX', null);  <- what we replaced",
    "  }",
    "}",
  ]);
  const stringFile = write("string.service.ts", [
    "export class StringService {",
    "  readonly hint = 'void this.dispatch.emit({ eventKey: 1 })';",
    "}",
  ]);

  assert("tier 1 detects a fire-and-forget notification dispatch", scanFile(badFile).length > 0);
  assert("tier 1 passes an awaited notification dispatch", scanFile(goodFile).length === 0);
  assert("tier 1 detects a fire-and-forget savePosition", scanFile(badCheckpointFile).length > 0);
  assert("tier 1 passes an awaited savePosition", scanFile(goodCheckpointFile).length === 0);
  assert("tier 1 ignores the banned shape quoted in a comment", scanFile(documentedFile).length === 0);
  assert("tier 1 ignores the banned shape inside a string literal", scanFile(stringFile).length === 0);
  assert(
    "blanking comments preserves line numbering",
    blankCommentsAndStrings("a\n/* x\n y */\nb").split("\n").length === 4,
  );

  // --- Tier 2: the shapes the old gate printed and ignored ---
  const floating = floatingPromises(
    [
      "void this.notifications.send({ orgId });",
      "void this.dispatch.emit({ eventKey: 'x' });",
      "void this.cursor.savePosition(p);",
      "void runSweep(orgId);",
      "void a.b.c.d(1);",
      "await this.notifications.send({ orgId });",
    ].join("\n"),
  );
  assert("tier 2 counts a plain `void this.x.y(`", floating.some((f) => f.method === "send"));
  assert("tier 2 counts the old gate's covered methods too", floating.some((f) => f.method === "emit"));
  assert("tier 2 counts a bare `void fn(`", floating.some((f) => f.method === "runSweep"));
  assert("tier 2 counts a deep member chain", floating.some((f) => f.method === "d"));
  assert("tier 2 ignores an awaited call", floating.length === 5);

  const swallowed = swallowedRejections(
    [
      "p.catch(() => undefined);",
      "p.catch(() => null);",
      "p.catch(() => {});",
      "p.catch((error) => undefined);",
      "p.catch(noop);",
      "p.catch((error) => { logger.error(error); });",
      "p.catch(handleProperly);",
    ].join("\n"),
  );
  assert("tier 2 counts `.catch(() => undefined)`", swallowed.length >= 5);
  assert(
    "tier 2 does not count a catch that actually handles",
    !swallowed.some((s) => s.text.includes("logger.error")),
  );
  assert(
    "tier 2 does not count a named handler",
    !swallowed.some((s) => s.text.includes("handleProperly")),
  );

  assert("registerAfterCommit is inventoried", afterCommitCalls("registerAfterCommit(() => x);") === 1);

  // --- the ratchet itself ---
  assert("the ratchet fails on a regression", verdict(TIER2_RATCHET + 1, TIER2_RATCHET) === "REGRESSION");
  assert("the ratchet passes at the pin", verdict(TIER2_RATCHET, TIER2_RATCHET) === "AT_RATCHET");
  assert("the ratchet reports an improvement", verdict(TIER2_RATCHET - 1, TIER2_RATCHET) === "IMPROVED");
  assert("the ratchet is a real number, not a placeholder", Number.isInteger(TIER2_RATCHET) && TIER2_RATCHET > 0);

  // The failure this gate is named for: a gate that finds something and exits 0.
  assert(
    "a tier 2 count above the ratchet cannot produce a passing verdict",
    verdict(TIER2_RATCHET + 50, TIER2_RATCHET) !== "AT_RATCHET" &&
      verdict(TIER2_RATCHET + 50, TIER2_RATCHET) !== "IMPROVED",
  );

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error(`check-fire-and-forget self-tests: ${failures.length} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`check-fire-and-forget self-tests: ${passed} passed`);
  process.exit(0);
}

if (SELF_TEST) runSelfTest();

const files = collectFiles(ROOT);
if (files.length < MIN_FILES) {
  console.error(
    `INCONCLUSIVE: scanned ${files.length} files (floor ${MIN_FILES}) — too few to be a real scan`,
  );
  process.exit(2);
}

const tier1 = [];
let floatingCount = 0;
let swallowedCount = 0;
let afterCommitCount = 0;
const byMethod = new Map();
const byFile = new Map();

for (const file of files) {
  for (const v of scanFile(file)) tier1.push({ file: file.replace(/\\/g, "/"), ...v });

  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const floating = floatingPromises(src);
  const swallowed = swallowedRejections(src);
  floatingCount += floating.length;
  swallowedCount += swallowed.length;
  afterCommitCount += afterCommitCalls(src);
  for (const f of floating) byMethod.set(f.method, (byMethod.get(f.method) ?? 0) + 1);
  const total = floating.length + swallowed.length;
  if (total > 0) byFile.set(file.replace(ROOT + "/", ""), total);
}

const tier2Count = floatingCount + swallowedCount;
const tier2Verdict = verdict(tier2Count, TIER2_RATCHET);

console.log(`Scanned ${files.length} TypeScript files under src/`);
console.log(`TIER 1 (banned)    : ${tier1.length} violation(s) — must be 0`);
console.log(
  `TIER 2 (ratcheted) : ${tier2Count} (${floatingCount} floating promises + ${swallowedCount} swallowed rejections) vs ratchet ${TIER2_RATCHET}`,
);
console.log(
  `INVENTORY          : ${afterCommitCount} registerAfterCommit call(s) — a sanctioned mechanism (CLAUDE.md §4), reported, not gated`,
);

if (tier1.length > 0) {
  console.error("\nFAIL (tier 1) — fire-and-forget notification dispatch / checkpoint writes:");
  for (const v of tier1) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  console.error("\nFix: replace  void this.<dispatch>.emit({...})  with  await this.<dispatch>.emit({...})");
  process.exit(1);
}

if (tier2Verdict === "REGRESSION") {
  console.error(
    `\nFAIL (tier 2) — ${tier2Count - TIER2_RATCHET} new floating promise(s) / swallowed rejection(s) above the ratchet of ${TIER2_RATCHET}.`,
  );
  console.error("Heaviest files:");
  for (const [file, n] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 15))
    console.error(`  ${n}\t${file}`);
  console.error("\nMost common discarded methods:");
  for (const [method, n] of [...byMethod].sort((a, b) => b[1] - a[1]).slice(0, 15))
    console.error(`  .${method}()\t${n}`);
  console.error(
    "\nDo not raise the ratchet to clear this. Route the effect through the outbox, `registerAfterCommit`,",
  );
  console.error("or await it — see backend/CLAUDE.md §4 for which of the three applies.");
  process.exit(1);
}

if (tier2Verdict === "IMPROVED") {
  console.log(
    `\nTIER 2 IMPROVED — ${TIER2_RATCHET - tier2Count} fewer than the ratchet. Lower TIER2_RATCHET to ${tier2Count} in ${"src/scripts/check-fire-and-forget.mjs"} so the gain is held.`,
  );
}

console.log(
  `\ncheck:fire-and-forget PASSED — tier 1 clean, tier 2 at ${tier2Count} (ratchet ${TIER2_RATCHET})`,
);
process.exit(0);
