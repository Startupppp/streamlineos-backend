/**
 * check-tenant-neutral.mjs
 *
 * StreamlineOS inventory is a generic multi-tenant WMS. A kirana, a pharmacy, a
 * distributor and a warehouse operator are all just organisations on it, and no
 * one of them may be named in the code that serves all of them.
 *
 * This is a ratchet rather than a review item because the coupling never
 * arrives as an obvious mistake. It arrives as a seed script that is genuinely
 * useful, a migration filename that matches the ticket, a test fixture named
 * after a real warehouse somebody had open in another tab. Each is a small
 * convenience; together they are a fork of the module that only one customer
 * can run. Buildmart was removed this way once (see
 * docs/inventory/BUILD_MART_DECOUPLE.md) and nothing stopped it going in.
 *
 * What this does NOT forbid: industry vocabulary. `DARK_STORE` is a facility
 * type Blinkit, Instamart and Zepto all run; `materials` is a catalogue shape;
 * a `zone` is any tenant's carve-up of a city. Those are the generic concepts
 * the packs exist to express. Only proper nouns are banned.
 *
 * Usage:
 *   node src/scripts/check-tenant-neutral.mjs
 *   node src/scripts/check-tenant-neutral.mjs --json
 *   node src/scripts/check-tenant-neutral.mjs --self-test
 *
 * Exit codes:
 *   0 — no customer proper noun in scanned source
 *   1 — a banned token, or a stale ALLOWED entry
 *   2 — vacuity guard fired (the scan reached too little to mean anything)
 *   3 — self-test failure
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "../..");

/**
 * Every token is a proper noun: a company, a locality, or an identifier built
 * out of one. `word` is matched case-insensitively and NOT on a word boundary,
 * because the shapes that actually appeared were `seed-buildmart`,
 * `packBuildmart`, `buildmart_dev` and `.next-buildmart` — a `\b` anchor would
 * have passed three of the four.
 */
const BANNED = [
  { token: "buildmart", why: "a customer, not a tenant of this codebase" },
  { token: "cornerstone", why: "a customer, not a tenant of this codebase" },
  { token: "gachibowli", why: "one customer's locality" },
  { token: "kompally", why: "one customer's locality" },
  { token: "shamshabad", why: "one customer's locality" },
  { token: "attapur", why: "one customer's locality" },
  { token: "homerun", why: "a third-party product name" },
];

/** Directories that are output, vendored, or somebody's local scratch. */
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next", ".turbo", ".scratch",
]);

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".sql", ".json", ".md", ".yml", ".yaml"]);

/**
 * Roots, in the order a reader would look. `migrations` is here because a
 * migration filename is a permanent public name — it is written into
 * `_journal.json` and quoted in every deploy log — and `docs` is here because a
 * document claiming the module belongs to one company is the coupling that
 * survives longest after the code is clean.
 */
const SCAN_ROOTS = ["src", "migrations", "docs", "scripts", "test"];
const SCAN_FILES = [".env.example", "package.json", "README.md"];

/**
 * An acknowledged mention, with the reason it is allowed to stand. The decouple
 * record is the one file that must name what was removed, or the next person
 * re-adds it not knowing it was ever a decision.
 */
const ALLOWED = [
  {
    file: "docs/inventory/BUILD_MART_DECOUPLE.md",
    why: "the decision record itself — it has to name what was removed",
  },
  {
    file: "src/scripts/check-tenant-neutral.mjs",
    why: "this gate; the banned list is the list",
  },
];

/** A banned token in one line of source. */
export function bannedIn(line) {
  const lower = line.toLowerCase();
  return BANNED.filter((entry) => lower.includes(entry.token));
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SCAN_EXTENSIONS.has(extname(entry.name))) yield full;
  }
}

function collectFiles() {
  const files = [];
  for (const root of SCAN_ROOTS) files.push(...walk(join(ROOT, root)));
  for (const name of SCAN_FILES) {
    const full = join(ROOT, name);
    try {
      if (statSync(full).isFile()) files.push(full);
    } catch {
      /* absent is fine; the vacuity guard is what notices a broken scan */
    }
  }
  return files;
}

function main() {
  const json = process.argv.includes("--json");
  const files = collectFiles();
  const allowed = new Set(ALLOWED.map((e) => e.file));

  const violations = [];
  const allowedHit = new Set();

  for (const full of files) {
    const rel = relative(ROOT, full);
    let source;
    try {
      source = readFileSync(full, "utf8");
    } catch {
      continue;
    }

    /**
     * The path is checked as well as the content. `seed-buildmart.ts` could
     * have contained no banned word at all and still been the coupling: a file
     * named for a customer is a file only that customer's work goes in.
     */
    const pathHits = bannedIn(rel);
    const lineHits = [];
    source.split("\n").forEach((line, index) => {
      for (const entry of bannedIn(line)) lineHits.push({ line: index + 1, ...entry, text: line.trim().slice(0, 120) });
    });

    if (pathHits.length === 0 && lineHits.length === 0) continue;
    if (allowed.has(rel)) {
      allowedHit.add(rel);
      continue;
    }
    violations.push({ file: rel, pathHits, lineHits });
  }

  /**
   * Vacuity floor. A gate that walked the wrong directory reports zero
   * violations and exits 0, which is indistinguishable from a clean repo — the
   * failure mode these scripts have had more than once. Both numbers have to be
   * real: enough files, and the migrations directory actually reached.
   */
  const migrationCount = files.filter((f) => relative(ROOT, f).startsWith("migrations/")).length;
  const MIN_FILES = 500;
  const MIN_MIGRATIONS = 100;
  if (files.length < MIN_FILES || migrationCount < MIN_MIGRATIONS) {
    process.stdout.write(
      `VACUITY GUARD — scanned ${files.length} files (floor ${MIN_FILES}) of which ` +
        `${migrationCount} migrations (floor ${MIN_MIGRATIONS}). The scan did not reach the ` +
        `repository; a clean result here would mean nothing.\n`,
    );
    process.exit(2);
  }

  if (json) {
    process.stdout.write(JSON.stringify({ scanned: files.length, migrationCount, violations }, null, 2) + "\n");
  }

  if (violations.length > 0) {
    process.stdout.write(`FAIL — a customer proper noun in ${violations.length} file(s):\n`);
    for (const v of violations) {
      for (const hit of v.pathHits) process.stdout.write(`  ${v.file}  (in the path) — "${hit.token}": ${hit.why}\n`);
      for (const hit of v.lineHits) process.stdout.write(`  ${v.file}:${hit.line} — "${hit.token}": ${hit.why}\n      ${hit.text}\n`);
    }
    process.stdout.write(
      `\nInventory serves every organisation that holds stock. If the capability is real, ` +
        `name it for what it does (materials, dark store, zone) and let a tenant supply its own ` +
        `data. See docs/inventory/BUILD_MART_DECOUPLE.md.\n`,
    );
    process.exit(1);
  }

  /** An allowlist entry nobody needs is an allowlist entry nobody reads. */
  const stale = ALLOWED.filter((e) => !allowedHit.has(e.file));
  if (stale.length > 0) {
    process.stdout.write(`FAIL — ${stale.length} ALLOWED entry(ies) no longer match anything:\n`);
    for (const e of stale) process.stdout.write(`  ${e.file} — ${e.why}\n`);
    process.stdout.write(`\nRemove the entry from ALLOWED in this file.\n`);
    process.exit(1);
  }

  process.stdout.write(
    `PASS — ${files.length} files (${migrationCount} migrations), ${BANNED.length} banned tokens, ` +
      `${ALLOWED.length} acknowledged mention(s).\n`,
  );
}

function selfTest() {
  const cases = [
    ["const ORG_SLUG = \"buildmart-materials\";", true],
    ["import { X } from \"./buildmart/needs-attention-board\";", true],
    ["packBuildmart: z.boolean().optional(),", true],
    ["DATABASE_URL=postgresql://me@127.0.0.1:5432/buildmart_dev", true],
    [".next-buildmart", true],
    ["createdb cornerstone_cold", true],
    ["name: \"Gachibowli DC\"", true],
    ["{ code: \"HYD-N-KMP\", name: \"Kompally Dark Store\" }", true],
    // Generic vocabulary the packs are built out of: never a violation.
    ["CREATE TYPE inv_facility_type AS ENUM ('DARK_STORE', 'WAREHOUSE');", false],
    ["packMaterials: boolean(\"pack_materials\").default(false).notNull(),", false],
    ["zone: text(\"zone\"),", false],
    ["deliveryPromiseMinutes: integer(\"delivery_promise_minutes\"),", false],
    ["const HYD_NORTH = tenant.zones[0];", false],
  ];

  let failed = 0;
  for (const [line, expected] of cases) {
    const actual = bannedIn(line).length > 0;
    if (actual !== expected) {
      failed += 1;
      process.stdout.write(`  self-test FAIL: ${JSON.stringify(line)} -> ${actual}, want ${expected}\n`);
    }
  }

  /**
   * The scan must also actually reach the tree. A matcher that is correct on
   * strings and a walker that visits nothing is the exact pair that has passed
   * green here before, so the self-test asserts both.
   */
  const files = collectFiles();
  const migrationCount = files.filter((f) => relative(ROOT, f).startsWith("migrations/")).length;
  if (files.length < 500 || migrationCount < 100) {
    process.stdout.write(`  self-test FAIL: walker reached ${files.length} files, ${migrationCount} migrations\n`);
    failed += 1;
  }

  if (failed > 0) {
    process.stdout.write(`SELF-TEST FAIL — ${failed} case(s)\n`);
    process.exit(3);
  }
  process.stdout.write(`SELF-TEST PASS — ${cases.length} matcher cases, walker reached ${files.length} files\n`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
