#!/usr/bin/env node
/**
 * check-test-suppressions.mjs
 *
 * Separates an HONEST skip from a QUARANTINE.
 *
 * THE DISTINCTION THIS GATE EXISTS TO MAKE
 * A skip that names an infrastructure blocker is honest: there is no S3/R2
 * endpoint, no Ably key, no provisioned read replica, so the suite cannot run
 * and says so. A skip that wraps live assertions is not honest: the assertions
 * exist, they are known to run, and switching them off is indistinguishable
 * from deleting them — except that the file still reads as covered.
 *
 * Before this gate the two were the same string in the same grep. `quotes.
 * service.spec.ts` carried `it.skip("create: sets approvalStatus=pending when
 * discount exceeds maxDiscountPercent")` with an EMPTY body while the discount
 * approval logic it named was live in two places; nine `it.skip`s in
 * `src/degradation/**` carried empty bodies naming a real missing endpoint.
 * Identical shape, opposite meaning. Only a registry that records WHICH, with
 * the blocker written down, keeps the distinction after the person who knew it
 * has moved on.
 *
 * CLASSIFICATION
 *   CONDITIONAL  the suppression is selected at runtime
 *                (`const d = url ? describe : describe.skip`) or the title is
 *                not a literal (a helper such as `test/helpers/db-describe.ts`).
 *                Honest by construction: the suite runs the moment the
 *                prerequisite exists. Counted, never registered.
 *   PLACEHOLDER  unconditional, and the body contains no `expect(`. Nothing is
 *                being switched off because nothing was ever written. Allowed
 *                only with a registered blocker.
 *   QUARANTINE   unconditional, and the body contains at least one `expect(`.
 *                Live assertions that do not run. Allowed only with a
 *                registered blocker AND within the recorded ratchet, because
 *                this is the shape that hides a failing assertion.
 *
 * DETECTION STRATEGY
 * 1. Walk every spec file under src/ and test/ (readdirSync, no shell glob).
 * 2. Match `it|test|describe . skip|todo|failing (` and `xit|xdescribe (`.
 * 3. Take the first literal argument as the title, brace-match the callback
 *    body, and count `expect(` inside it.
 * 4. Join each site to `baselines/test-suppressions.json` by file + title.
 *
 * VACUITY GUARDS
 * - Fewer than MIN_SPEC_FILES spec files walked  -> exit 2
 * - Fewer than MIN_SITES suppression sites found -> exit 2
 * A scan that reaches nothing reports a clean tree, which is the failure mode
 * this whole release exists to remove.
 *
 * SELF-TEST (--self-test)
 * Runs the same classifier over planted fixtures: an empty-bodied skip, a skip
 * holding assertions, a conditional alias, a helper skip, an xdescribe and a
 * todo — and asserts each lands in the right class. Then asserts the registry
 * join and every failure branch on synthetic input.
 *
 * Usage:
 *   node src/scripts/check-test-suppressions.mjs [--self-test] [--list]
 *
 * Exit codes:
 *   0 — every suppression is classified and registered, ratchet held
 *   1 — an unregistered suppression, a stale entry, a misclassification, or a
 *       quarantine count above the ratchet (or self-test failed)
 *   2 — the scan measured nothing
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const LIST = process.argv.includes("--list");

const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const SCAN_ROOTS = ["src", "test", "evals"];
const REGISTRY_PATH = join(BACKEND_ROOT, "src/scripts/baselines/test-suppressions.json");

const MIN_SPEC_FILES = 200;
const MIN_SITES = 5;

/**
 * Live assertions that do not run. May only go down. Every entry is registered
 * with its blocker in baselines/test-suppressions.json.
 *
 * 6 -> 0 on 2026-09-12. The six were the `describe.skip` blocks of
 * `ai/core/crm-copilot.service.phase2.spec.ts`, and they were un-skipped on
 * 2026-09-10 — that file's own header records the three rotted things the
 * un-skip found. Their registry entries outlived the suppression and the gate
 * had been reporting "quarantine 0 (ratchet 6)" ever since. Six of slack is six
 * regressions a future change may land for free, which is the same defect as a
 * baseline raised to go green, pointing the other way. There is now no spec in
 * this repository whose live assertions are switched off; adding one has to
 * argue for itself here.
 */
const QUARANTINE_BASELINE = 0;

/**
 * Suppressions selected at runtime, plus helper wrappers. Honest, but ratcheted
 * so a hand-written skip cannot be laundered into this class by hiding behind a
 * variable.
 *
 * ── 2026-09-07: 76 -> 20, BY RETIRING THE CLASS RATHER THAN REPRICING IT ────
 *
 * This number spent the 10-10 release RED at 76 against 29, and the raise was
 * refused twice. The note that stood here committed in writing that "the next
 * request to raise it should retire an existing conditional site instead of
 * adding to the count". That is what happened, so the history is kept short:
 *
 *   * 56 `*.db.spec.ts` files each opened with
 *     `const describeDb = ENABLED && DB_URL ? describe : describe.skip`.
 *     That ternary WAS the suppression, and it existed only because the default
 *     `jest` run walked those files on machines with no database.
 *   * They are now selected by SUITE instead, exactly as `*.e2e-spec.ts` already
 *     was: `jest-db.json` selects the 56, `pnpm test:db-specs` runs them, and the
 *     default `jest` config ignores `\.db\.spec\.ts$`. With the file unreachable
 *     from the hermetic run the gate is redundant, so it is gone, and each spec
 *     now THROWS naming the variable it needs when its database is absent.
 *     A missing prerequisite fails loudly; it can no longer skip.
 *   * 19 of the 56 also held a hermetic half that ran in the default suite. That
 *     half was SPLIT into a sibling `*.spec.ts` rather than left to fall out of
 *     the run silently — 16 files, 71 tests, all passing with no database.
 *     Splitting a file is the standard way to lose coverage by accident; it was
 *     counted before and after on purpose.
 *
 * 29 -> 20 on the same change. A ratchet is lowered to the measured value, never
 * raised to fit one: 20 is what the tree now holds, and it can only make this
 * gate stricter. The survivors are the genuinely infrastructure-gated ones —
 * 9 `*.eval.spec.ts` needing an AI provider key, 6 `src/degradation/**` needing
 * a real S3/Ably/read-replica, and the seeded-E2E and perf specs that need
 * specific tenant fixtures to mean anything.
 *
 * This also dissolves the tension recorded against PRD-C018, which said every new
 * DB-gated spec written to close it pushed this count up. A new `*.db.spec.ts`
 * now joins `jest-db.json` and adds NOTHING to this class.
 *
 * `db-gates.yml`'s `Database-gated spec suites` step stays `if:`-guarded: that job
 * has no seed step, and some suites read seeded rows. That guard is a CI-coverage
 * question now, not this ratchet's — the class it priced no longer exists.
 */
// Lowered 20 -> 19 after replacing the unwired tenant-integrity conditional with explicit unit-only/live-probe separation.
const CONDITIONAL_BASELINE = 18;

const SITE_RE =
  /(^|[^A-Za-z0-9_$.])(?:(it|test|describe)\s*\.\s*(skip|todo|failing)|(xit|xdescribe))\s*\(/g;

const CONDITIONAL_ALIAS_RE =
  /\?\s*describe\s*:\s*describe\s*\.\s*skip|describe\s*\.\s*skip\s*:\s*describe|\?\s*it\s*:\s*it\s*\.\s*skip|it\s*\.\s*skip\s*:\s*it/;

function walk(dir, out) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(spec|e2e-spec|test)\.tsx?$/.test(entry) || /^db-describe\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** First literal string argument of the call opening at `openParen`, or null. */
function readTitle(text, openParen) {
  let i = openParen + 1;
  while (i < text.length && /\s/.test(text[i])) i++;
  const quote = text[i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let out = "";
  i++;
  while (i < text.length) {
    if (text[i] === "\\") {
      out += text[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (text[i] === quote) return out;
    out += text[i];
    i++;
  }
  return null;
}

/**
 * Body of the callback argument, brace-matched. String and template contents
 * are skipped so a brace inside a title or a fixture literal cannot unbalance
 * the scan. Returns "" when the call has no callback (`it.todo`).
 */
function readBody(text, openParen) {
  let depth = 1;
  let i = openParen + 1;
  let bodyStart = -1;
  let braceDepth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === quote) break;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) break;
    } else if (ch === "{") {
      if (bodyStart === -1) bodyStart = i;
      braceDepth++;
    } else if (ch === "}") {
      braceDepth--;
      if (bodyStart !== -1 && braceDepth === 0) return text.slice(bodyStart, i + 1);
    }
    i++;
  }
  return "";
}

/** Classify one suppression site. Exported shape is what the self-test drives. */
export function classifySite({ title, body, lineText }) {
  if (title === null) return "CONDITIONAL";
  if (CONDITIONAL_ALIAS_RE.test(lineText)) return "CONDITIONAL";
  return /\bexpect\s*\(/.test(body) ? "QUARANTINE" : "PLACEHOLDER";
}

export function scanText(text, file) {
  const sites = [];
  SITE_RE.lastIndex = 0;
  let m;
  while ((m = SITE_RE.exec(text)) !== null) {
    const openParen = SITE_RE.lastIndex - 1;
    const kind = m[4] ?? `${m[2]}.${m[3]}`;
    const title = readTitle(text, openParen);
    const body = readBody(text, openParen);
    const line = text.slice(0, m.index).split("\n").length;
    const lineText = text.split("\n")[line - 1] ?? "";
    sites.push({
      file,
      line,
      kind,
      title,
      klass: classifySite({ title, body, lineText }),
    });
  }
  return sites;
}

/** Conditional aliases are declarations, not call sites; count them separately. */
export function countConditionalAliases(text) {
  return text.split("\n").filter((l) => CONDITIONAL_ALIAS_RE.test(l)).length;
}

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) return [];
  const parsed = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  return Array.isArray(parsed.entries) ? parsed.entries : [];
}

export function reconcile(sites, entries) {
  const byKey = new Map();
  for (const e of entries) byKey.set(`${e.file}::${e.title}`, e);

  const unregistered = [];
  const misclassified = [];
  const matched = new Set();

  for (const s of sites) {
    if (s.klass === "CONDITIONAL") continue;
    const key = `${s.file}::${s.title}`;
    const entry = byKey.get(key);
    if (entry === undefined) {
      unregistered.push(s);
      continue;
    }
    matched.add(key);
    if (entry.class !== s.klass) misclassified.push({ site: s, declared: entry.class });
    if (typeof entry.blocker !== "string" || entry.blocker.trim().length < 12)
      misclassified.push({ site: s, declared: `blocker not stated (${String(entry.blocker)})` });
  }

  const stale = entries.filter((e) => !matched.has(`${e.file}::${e.title}`));
  return { unregistered, misclassified, stale };
}

function runSelfTest() {
  let failures = 0;
  const assert = (label, cond) => {
    if (!cond) {
      console.error(`  FAIL ${label}`);
      failures++;
    }
  };

  const placeholder = `
    it.skip("uploads to R2 when an endpoint is configured", async () => {});
  `;
  assert(
    "an empty-bodied skip is a PLACEHOLDER",
    scanText(placeholder, "f.spec.ts")[0].klass === "PLACEHOLDER",
  );

  const quarantine = `
    describe.skip("stalePipelineDigest", () => {
      it("throws when the flag is off", async () => {
        await expect(service.run()).rejects.toThrow();
      });
    });
  `;
  const qSites = scanText(quarantine, "f.spec.ts");
  assert("a skip holding assertions is a QUARANTINE", qSites[0].klass === "QUARANTINE");
  assert("the inner live `it` is not itself a site", qSites.length === 1);

  const conditional = `
    const describeWithDb = databaseUrl ? describe : describe.skip;
  `;
  assert(
    "a conditional alias is not a call site",
    scanText(conditional, "f.spec.ts").length === 0,
  );
  assert("a conditional alias is counted", countConditionalAliases(conditional) === 1);

  const helper = `
    export function dbDescribe(name, fn) {
      describe.skip(name, fn);
    }
  `;
  assert(
    "a non-literal title is CONDITIONAL (a helper, not a hand-written skip)",
    scanText(helper, "h.ts")[0].klass === "CONDITIONAL",
  );

  const todo = `it.todo("400 on non-numeric projectId");`;
  assert("a todo is a PLACEHOLDER", scanText(todo, "f.spec.ts")[0].klass === "PLACEHOLDER");

  const legacy = `xdescribe("old suite", () => { it("x", () => { expect(1).toBe(1); }); });`;
  assert("xdescribe is detected", scanText(legacy, "f.spec.ts")[0].kind === "xdescribe");
  assert("xdescribe holding assertions is a QUARANTINE", scanText(legacy, "f.spec.ts")[0].klass === "QUARANTINE");

  assert(
    "a plain `it(` is never a site",
    scanText(`it("runs", () => { expect(1).toBe(1); });`, "f.spec.ts").length === 0,
  );
  assert(
    "a word ending in `it` is never a site",
    scanText(`await submit.skip("x", () => {});`, "f.spec.ts").length === 0,
  );

  const bracedTitle = `it.skip("renders { a: 1 } correctly", () => { expect(1).toBe(1); });`;
  assert(
    "a brace inside the title does not unbalance the body scan",
    scanText(bracedTitle, "f.spec.ts")[0].klass === "QUARANTINE",
  );

  const site = { file: "a.spec.ts", line: 1, kind: "it.skip", title: "t", klass: "PLACEHOLDER" };
  assert(
    "an unregistered suppression is reported",
    reconcile([site], []).unregistered.length === 1,
  );
  assert(
    "a registered suppression with a stated blocker is accepted",
    reconcile([site], [{ file: "a.spec.ts", title: "t", class: "PLACEHOLDER", blocker: "no S3/R2 endpoint is provisioned" }])
      .unregistered.length === 0,
  );
  assert(
    "a registry entry that declares the wrong class is reported",
    reconcile([site], [{ file: "a.spec.ts", title: "t", class: "QUARANTINE", blocker: "no S3/R2 endpoint is provisioned" }])
      .misclassified.length === 1,
  );
  assert(
    "a registry entry with no stated blocker is reported",
    reconcile([site], [{ file: "a.spec.ts", title: "t", class: "PLACEHOLDER", blocker: "tbd" }])
      .misclassified.length === 1,
  );
  assert(
    "a stale registry entry is reported",
    reconcile([], [{ file: "gone.spec.ts", title: "t", class: "PLACEHOLDER", blocker: "no S3/R2 endpoint is provisioned" }])
      .stale.length === 1,
  );
  assert(
    "a CONDITIONAL site never needs registration",
    reconcile([{ ...site, klass: "CONDITIONAL" }], []).unregistered.length === 0,
  );

  const registry = loadRegistry();
  assert("the live registry parses and is non-empty", registry.length > 0);
  assert(
    "every live registry entry states a blocker",
    registry.every((e) => typeof e.blocker === "string" && e.blocker.trim().length >= 12),
  );

  if (failures > 0) {
    console.error(`check-test-suppressions self-test: ${failures} failed`);
    process.exit(1);
  }
  console.log("check-test-suppressions self-tests: 20 passed");
  process.exit(0);
}

if (SELF_TEST) runSelfTest();

const files = [];
for (const root of SCAN_ROOTS) walk(join(BACKEND_ROOT, root), files);

let sites = [];
let conditionalAliases = 0;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  conditionalAliases += countConditionalAliases(text);
  sites = sites.concat(scanText(text, relative(BACKEND_ROOT, f).replace(/\\/g, "/")));
}

if (files.length < MIN_SPEC_FILES) {
  console.error(
    `INCONCLUSIVE — walked ${files.length} spec files (floor ${MIN_SPEC_FILES}). The walk is broken; "no suppressions" would prove nothing.`,
  );
  process.exit(2);
}
if (sites.length + conditionalAliases < MIN_SITES) {
  console.error(
    `INCONCLUSIVE — found ${sites.length} suppression sites and ${conditionalAliases} conditional aliases (floor ${MIN_SITES} combined). The matcher is broken.`,
  );
  process.exit(2);
}

const conditional = sites.filter((s) => s.klass === "CONDITIONAL");
const placeholders = sites.filter((s) => s.klass === "PLACEHOLDER");
const quarantines = sites.filter((s) => s.klass === "QUARANTINE");

console.log(
  `Spec files ${files.length}  ·  suppression sites ${sites.length}  ·  conditional aliases ${conditionalAliases}`,
);
console.log(
  `  conditional ${conditional.length + conditionalAliases}  ·  placeholder ${placeholders.length}  ·  quarantine ${quarantines.length}`,
);

if (LIST) {
  for (const s of sites.sort((a, b) => a.file.localeCompare(b.file)))
    console.log(`  ${s.klass.padEnd(11)} ${s.file}:${s.line}  ${s.kind}  ${s.title ?? "<non-literal>"}`);
  process.exit(0);
}

const { unregistered, misclassified, stale } = reconcile(sites, loadRegistry());
let failed = false;

if (unregistered.length > 0) {
  console.error(
    `\nFAIL — ${unregistered.length} suppression(s) with no entry in baselines/test-suppressions.json. A skip whose blocker is not written down is indistinguishable from a hidden failure:`,
  );
  for (const s of unregistered) console.error(`  ${s.file}:${s.line}  ${s.kind}  ${s.title ?? "<non-literal>"}  (${s.klass})`);
  failed = true;
}

if (misclassified.length > 0) {
  console.error(`\nFAIL — ${misclassified.length} registry entry(ies) do not describe the site they name:`);
  for (const m of misclassified)
    console.error(`  ${m.site.file}  "${m.site.title}"  measured ${m.site.klass}, declared ${m.declared}`);
  failed = true;
}

if (stale.length > 0) {
  console.error(`\nFAIL — ${stale.length} stale registry entry(ies); the suppression is gone. Remove them so the registry cannot rot into a permanent exemption:`);
  for (const e of stale) console.error(`  ${e.file}  "${e.title}"`);
  failed = true;
}

if (quarantines.length > QUARANTINE_BASELINE) {
  console.error(
    `\nFAIL — ${quarantines.length} suppression(s) hold live assertions, ${quarantines.length - QUARANTINE_BASELINE} above the recorded ratchet of ${QUARANTINE_BASELINE}. Switching an assertion off is not the same as it passing.`,
  );
  failed = true;
}

if (conditional.length + conditionalAliases > CONDITIONAL_BASELINE) {
  console.error(
    `\nFAIL — ${conditional.length + conditionalAliases} runtime-selected suppressions, above the ratchet of ${CONDITIONAL_BASELINE}. This class is honest but it is also the easiest place to launder a hand-written skip, so it is capped.`,
  );
  failed = true;
}

if (failed) process.exit(1);

console.log(
  `\nOK — every suppression is registered with a stated blocker. Quarantine ${quarantines.length} (ratchet ${QUARANTINE_BASELINE}) · conditional ${conditional.length + conditionalAliases} (ratchet ${CONDITIONAL_BASELINE}).`,
);
console.log(
  "PLACEHOLDER means nothing was ever written; QUARANTINE means live assertions do not run. Both ratchets may only go down.",
);
