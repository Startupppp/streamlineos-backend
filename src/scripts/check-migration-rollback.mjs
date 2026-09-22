/**
 * check-migration-rollback.mjs
 *
 * Gate: every forward migration above the baseline cutoff must have either
 *   (a) a corresponding rollback file at migrations/rollback/<tag>.down.sql, OR
 *   (b) an explicit machine-readable declaration inside the migration file:
 *         -- @irreversible   (DROP COLUMN, DROP TABLE, destructive writes)
 *         -- @data-loss      (synonym accepted by this gate)
 *
 * Additionally, for every rollback file that exists (historical or new):
 *   Each type created by CREATE TYPE "name" in the forward migration must appear
 *   in a DROP TYPE statement in the rollback. A mismatched name means the rollback
 *   cannot reverse the forward, and is the static footprint of the 0143-class defect
 *   (timesheet_budget_status: partial index from a later migration blocked the type
 *   conversion because the rollback did not drop the dependent index first — the
 *   type name check is the earliest static signal of that family of error).
 *
 * Baseline cutoff: migrations with numeric prefix <= BASELINE_CUTOFF are
 * grandfathered. The gate enforces compliance only on NEW migrations added after
 * the baseline. The baseline can only advance, never retreat.
 *
 * Self-test (--self-test):
 *   Creates temp fixture directories, exercises both failure modes with minimal
 *   fixture files, asserts each bites, then removes the fixtures. A guard that
 *   has never failed is not a guard.
 *
 * Usage:
 *   node src/scripts/check-migration-rollback.mjs [--migrations=migrations] [--self-test]
 * Exit:
 *   0   clean (or self-test passed)
 *   1   violations found or self-test failure
 *   2   vacuity check failed (filesystem walk is broken)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");

const argv = process.argv.slice(2);
const SELF_TEST = argv.includes("--self-test");
const MIGRATIONS_DIR = resolve(
  BACKEND_ROOT,
  (argv.find((a) => a.startsWith("--migrations=")) ?? "--migrations=migrations").slice(
    "--migrations=".length,
  ),
);

const ROLLBACK_DIR = join(MIGRATIONS_DIR, "rollback");

const MIN_SQL_FILES = 380;

/**
 * Migrations with numeric prefix <= this value are grandfathered.
 * Only migrations with numeric prefix > BASELINE_CUTOFF must comply.
 * Set to the HEAD migration at the time this gate was established (0839).
 */
const BASELINE_CUTOFF = 839;

/**
 * A migration is inventory when its tag says so. Stated as a rule so the number
 * below can be reproduced, rather than being a count somebody once made.
 */
const INVENTORY_TAG = /^\d+[a-z]?_(inv_|inventory)/;

/**
 * How many inventory migrations have neither a rollback file nor an
 * `-- @irreversible` declaration, and therefore pass this gate only because they
 * predate the cutoff. It can only shrink.
 *
 * The gate reported PASSED while enforcing exactly nothing about inventory: all
 * of them sit at or below 839, so the green covered the module and said so
 * nowhere. The count is now printed on every run and ratcheted here, so the debt
 * is a number somebody has to look at and cannot quietly grow.
 */
const INVENTORY_WITHOUT_ROLLBACK_BASELINE = 5;

/**
 * Files that are intentionally unjournalled and never applied via db:migrate.
 * They are exempt from the rollback requirement.
 */
const DELIBERATE_ALLOWLIST = new Set([
  "0478_invoice_line_items_column_drop",
  "0482_candidate_resume_column_drop",
  "0488_hr_people_drop_identity_cols",
  "0472_outbox_inbox_aggregate_fence",
]);

function numericPrefixOf(tag) {
  const m = /^(\d+)/.exec(tag);
  return m ? parseInt(m[1], 10) : 0;
}

function extractCreatedTypes(content) {
  const names = new Set();
  const re = /CREATE\s+TYPE\s+"([^"]+)"/gi;
  let m;
  while ((m = re.exec(content)) !== null) names.add(m[1].toLowerCase());
  return names;
}

function extractDroppedTypes(content) {
  const names = new Set();
  const re = /DROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi;
  let m;
  while ((m = re.exec(content)) !== null) names.add(m[1].toLowerCase());
  return names;
}

function hasIrreversibleDeclaration(content) {
  return /--\s*@irreversible|--\s*@data-loss/i.test(content);
}

function readJournalTags(migrationsDir) {
  const path = join(migrationsDir, "meta", "_journal.json");
  if (!existsSync(path)) return new Set();
  const j = JSON.parse(readFileSync(path, "utf8"));
  return new Set(j.entries.map((e) => e.tag));
}

function scanMigrations(migrationsDir) {
  if (!existsSync(migrationsDir)) {
    process.stderr.write(`ERROR: migrations dir not found: ${migrationsDir}\n`);
    process.exit(2);
  }
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();
}

function scanRollbackFiles(rollbackDir) {
  if (!existsSync(rollbackDir)) return new Set();
  return new Set(
    readdirSync(rollbackDir)
      .filter((f) => f.endsWith(".down.sql"))
      .map((f) => f.replace(/\.down\.sql$/, "")),
  );
}

/**
 * The accounting the gate used to keep to itself: how much of that PASSED is
 * exemption, and how much of the exemption is inventory.
 */
function exemptionCensus(migrationsDir, tags, journalTags, rollbacks) {
  const inventory = tags.filter((t) => INVENTORY_TAG.test(t));
  let withRollback = 0;
  let irreversible = 0;
  const neither = [];
  for (const tag of inventory) {
    if (rollbacks.has(tag)) {
      withRollback++;
      continue;
    }
    const content = readFileSync(join(migrationsDir, `${tag}.sql`), "utf8");
    if (hasIrreversibleDeclaration(content)) irreversible++;
    else neither.push(tag);
  }
  return {
    belowCutoff: tags.filter((t) => numericPrefixOf(t) <= BASELINE_CUTOFF).length,
    inventory: inventory.length,
    inventoryBelowCutoff: inventory.filter((t) => numericPrefixOf(t) <= BASELINE_CUTOFF).length,
    withRollback,
    irreversible,
    neither,
    journalled: journalTags.size,
  };
}

function runChecks(migrationsDir, { skipVacuity = false } = {}) {
  const tags = scanMigrations(migrationsDir);
  const journalTags = readJournalTags(migrationsDir);
  const rollbacks = scanRollbackFiles(join(migrationsDir, "rollback"));
  const violations = [];

  if (!skipVacuity && tags.length < MIN_SQL_FILES) {
    process.stderr.write(
      `ERROR (vacuity): found only ${tags.length} SQL files — expected at least ${MIN_SQL_FILES}. ` +
        `The filesystem walk is broken. Refusing to report a false clean pass.\n`,
    );
    process.exit(2);
  }

  for (const tag of tags) {
    if (DELIBERATE_ALLOWLIST.has(tag)) continue;

    const forwardContent = readFileSync(join(migrationsDir, `${tag}.sql`), "utf8");
    const createdTypes = extractCreatedTypes(forwardContent);

    if (rollbacks.has(tag)) {
      const downContent = readFileSync(join(migrationsDir, "rollback", `${tag}.down.sql`), "utf8");
      const droppedTypes = extractDroppedTypes(downContent);

      for (const typeName of createdTypes) {
        if (!droppedTypes.has(typeName)) {
          violations.push({
            tag,
            label: "type-mismatch",
            msg:
              `forward migration creates type "${typeName}" but the rollback has no DROP TYPE for it — ` +
              `the rollback cannot fully reverse the forward (0143-class defect)`,
          });
        }
      }
      continue;
    }

    if (numericPrefixOf(tag) <= BASELINE_CUTOFF) continue;

    if (hasIrreversibleDeclaration(forwardContent)) continue;

    if (!journalTags.has(tag)) continue;

    violations.push({
      tag,
      label: "no-rollback",
      msg:
        `migration "${tag}" has no rollback file and no -- @irreversible or -- @data-loss declaration — ` +
        `add migrations/rollback/${tag}.down.sql or add -- @irreversible to the migration if it is data-destructive`,
    });
  }

  const census = exemptionCensus(migrationsDir, tags, journalTags, rollbacks);
  if (!skipVacuity && census.neither.length > INVENTORY_WITHOUT_ROLLBACK_BASELINE)
    violations.push({
      tag: "inventory",
      label: "inventory-rollback-ratchet",
      msg:
        `${census.neither.length} inventory migrations have neither a rollback file nor an ` +
        `-- @irreversible declaration; the recorded baseline is ` +
        `${INVENTORY_WITHOUT_ROLLBACK_BASELINE} and it can only shrink. A new one below the ` +
        `${BASELINE_CUTOFF} cutoff cannot be added silently.`,
    });

  return { tags, violations, census };
}

function selfTest() {
  console.log("check-migration-rollback self-test");
  console.log("===================================");
  let passed = 0;
  let failed = 0;

  const tmp = join(tmpdir(), `rollback-selftest-${process.pid}`);
  mkdirSync(join(tmp, "meta"), { recursive: true });
  mkdirSync(join(tmp, "rollback"), { recursive: true });

  function writeJournal(tags) {
    const entries = tags.map((tag, i) => ({
      idx: i,
      version: "7",
      when: 1000 * (i + 1),
      tag,
      breakpoints: false,
    }));
    writeFileSync(
      join(tmp, "meta", "_journal.json"),
      JSON.stringify({ version: "7", dialect: "postgresql", entries }),
    );
  }

  function writeSql(tag, content) {
    writeFileSync(join(tmp, `${tag}.sql`), content);
  }

  function writeDown(tag, content) {
    writeFileSync(join(tmp, "rollback", `${tag}.down.sql`), content);
  }

  function cleanDir() {
    for (const f of readdirSync(tmp).filter((x) => x.endsWith(".sql")))
      rmSync(join(tmp, f));
    for (const f of readdirSync(join(tmp, "rollback")).filter((x) => x.endsWith(".sql")))
      rmSync(join(tmp, "rollback", f));
  }

  function assert(label, violations, expectedLabelLike) {
    const hit = violations.some((v) => v.label === expectedLabelLike || v.msg.includes(expectedLabelLike));
    if (hit) {
      console.log(`  PASS  ${label}`);
      passed++;
    } else {
      console.error(`  FAIL  ${label} — expected violation matching "${expectedLabelLike}"`);
      console.error(`         got: ${JSON.stringify(violations)}`);
      failed++;
    }
  }

  function assertClean(label, violations) {
    if (violations.length === 0) {
      console.log(`  PASS  ${label}`);
      passed++;
    } else {
      console.error(`  FAIL  ${label} — expected no violations, got: ${JSON.stringify(violations)}`);
      failed++;
    }
  }

  const ABOVE_CUTOFF = `${BASELINE_CUTOFF + 100}_new_feature`;
  const BELOW_CUTOFF = `0001_old_baseline`;

  const CONTENT_PLAIN = `SET lock_timeout = '5s';\nALTER TABLE foo ADD COLUMN bar integer;\n`;
  const CONTENT_IRREVERSIBLE = `SET lock_timeout = '5s';\n-- @irreversible\nALTER TABLE foo DROP COLUMN bar;\n`;
  const CONTENT_DATA_LOSS = `SET lock_timeout = '5s';\n-- @data-loss\nALTER TABLE foo DROP COLUMN bar;\n`;
  const CONTENT_WITH_TYPE = `SET lock_timeout = '5s';\nCREATE TYPE "my_good_enum" AS ENUM ('A', 'B');\nALTER TABLE foo ALTER COLUMN x TYPE "my_good_enum";\n`;
  const DOWN_CORRECT = `SET lock_timeout = '5s';\nALTER TABLE foo ALTER COLUMN x TYPE text USING x::text;\nDROP TYPE IF EXISTS "my_good_enum";\n`;
  const DOWN_WRONG_TYPE = `SET lock_timeout = '5s';\nALTER TABLE foo ALTER COLUMN x TYPE text USING x::text;\nDROP TYPE IF EXISTS "wrong_enum_name";\n`;
  const DOWN_PLAIN = `SET lock_timeout = '5s';\nALTER TABLE foo DROP COLUMN bar;\n`;

  function pad(n) {
    return String(n).padStart(4, "0");
  }

  console.log("\nFailure mode (a): migration above cutoff with no rollback and no declaration");
  {
    cleanDir();
    writeJournal([ABOVE_CUTOFF]);
    writeSql(ABOVE_CUTOFF, CONTENT_PLAIN);
    const { violations } = runChecks(tmp, { skipVacuity: true });
    assert("missing rollback and no declaration is caught (above cutoff)", violations, "no-rollback");
  }

  console.log("\nFailure mode (a): migration below cutoff with no rollback → grandfathered, no violation");
  {
    cleanDir();
    writeJournal([BELOW_CUTOFF]);
    writeSql(BELOW_CUTOFF, CONTENT_PLAIN);
    const { violations } = runChecks(tmp, { skipVacuity: true });
    assertClean("migration below cutoff is grandfathered", violations);
  }

  console.log("\nClean case: migration above cutoff with -- @irreversible declaration");
  {
    cleanDir();
    writeJournal([ABOVE_CUTOFF]);
    writeSql(ABOVE_CUTOFF, CONTENT_IRREVERSIBLE);
    const { violations } = runChecks(tmp, { skipVacuity: true });
    assertClean("@irreversible declaration satisfies the gate", violations);
  }

  console.log("\nClean case: migration above cutoff with -- @data-loss declaration");
  {
    cleanDir();
    writeJournal([ABOVE_CUTOFF]);
    writeSql(ABOVE_CUTOFF, CONTENT_DATA_LOSS);
    const { violations } = runChecks(tmp, { skipVacuity: true });
    assertClean("@data-loss declaration satisfies the gate", violations);
  }

  console.log("\nClean case: migration above cutoff with matching rollback (no CREATE TYPE)");
  {
    cleanDir();
    writeJournal([ABOVE_CUTOFF]);
    writeSql(ABOVE_CUTOFF, CONTENT_PLAIN);
    writeDown(ABOVE_CUTOFF, DOWN_PLAIN);
    const { violations } = runChecks(tmp, { skipVacuity: true });
    assertClean("rollback present with no CREATE TYPE passes", violations);
  }

  console.log("\nFailure mode (b): rollback exists but DROP TYPE name mismatches CREATE TYPE name");
  {
    cleanDir();
    writeJournal([ABOVE_CUTOFF]);
    writeSql(ABOVE_CUTOFF, CONTENT_WITH_TYPE);
    writeDown(ABOVE_CUTOFF, DOWN_WRONG_TYPE);
    const { violations } = runChecks(tmp, { skipVacuity: true });
    assert(
      "rollback with mismatched DROP TYPE name is caught (0143-class defect)",
      violations,
      "type-mismatch",
    );
  }

  console.log("\nClean case: rollback with correct DROP TYPE name");
  {
    cleanDir();
    writeJournal([ABOVE_CUTOFF]);
    writeSql(ABOVE_CUTOFF, CONTENT_WITH_TYPE);
    writeDown(ABOVE_CUTOFF, DOWN_CORRECT);
    const { violations } = runChecks(tmp, { skipVacuity: true });
    assertClean("rollback with correct DROP TYPE name passes", violations);
  }

  console.log("\nType-mismatch check applies to historical migrations too (below cutoff)");
  {
    cleanDir();
    writeJournal([BELOW_CUTOFF]);
    writeSql(BELOW_CUTOFF, CONTENT_WITH_TYPE);
    writeDown(BELOW_CUTOFF, DOWN_WRONG_TYPE);
    const { violations } = runChecks(tmp, { skipVacuity: true });
    assert(
      "type-mismatch caught for historical migration that has a rollback",
      violations,
      "type-mismatch",
    );
  }

  console.log("\nInjection: unjournalled file above cutoff is exempt");
  {
    cleanDir();
    const UNJOURNALLED_TAG = `${pad(BASELINE_CUTOFF + 101)}_unjournalled`;
    writeJournal([]);
    writeSql(UNJOURNALLED_TAG, CONTENT_PLAIN);
    const { violations } = runChecks(tmp, { skipVacuity: true });
    assertClean("unjournalled file above cutoff is not flagged (no journal = never applies)", violations);
  }

  rmSync(tmp, { recursive: true });

  console.log(`\nSelf-test: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("SELF-TEST FAILED");
    process.exitCode = 1;
  } else {
    console.log("SELF-TEST PASSED");
  }
}

async function main() {
  if (SELF_TEST) {
    selfTest();
    return;
  }

  const { tags, violations, census } = runChecks(MIGRATIONS_DIR);

  if (violations.length === 0) {
    console.log(`check:migration-rollback PASSED`);
    console.log(`  ${tags.length} migrations scanned`);
    console.log(`  Compliance required for numeric prefix > ${BASELINE_CUTOFF}`);
    console.log(`  All rollback type-name checks passed`);
    console.log(``);
    console.log(`  What that PASSED does not cover, printed here rather than left in the source:`);
    console.log(
      `    ${census.belowCutoff} of ${tags.length} migrations are at or below ${BASELINE_CUTOFF} ` +
        `and this gate requires nothing of them`,
    );
    console.log(
      `    inventory (tag matches ${INVENTORY_TAG.source}): ${census.inventory} migrations, ` +
        `${census.inventoryBelowCutoff} of them below the cutoff`,
    );
    console.log(`      ${census.withRollback} have migrations/rollback/<tag>.down.sql`);
    console.log(`      ${census.irreversible} declare -- @irreversible or -- @data-loss`);
    console.log(
      `      ${census.neither.length} have neither and pass only by the cutoff ` +
        `(baseline ${INVENTORY_WITHOUT_ROLLBACK_BASELINE}, can only shrink)`,
    );
    console.log(
      `    This gate never executes a rollback. \`pnpm drill:rollback\` does, and reports which ones run.`,
    );
    process.exit(0);
  }

  process.stderr.write(`check:migration-rollback FAILED — ${violations.length} violation(s)\n\n`);
  for (const { tag, label, msg } of violations) {
    process.stderr.write(`  [${label}] ${tag}\n    ${msg}\n\n`);
  }
  process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`check:migration-rollback FAILED: ${e instanceof Error ? e.message : e}\n`);
  process.exitCode = 1;
});
