/**
 * rehearse-migration-rollback.mjs — execute the rollbacks, do not just count them.
 *
 * `pnpm check:migration-rollback` passes, and passing meant only that a file
 * named `migrations/rollback/<tag>.down.sql` exists and that its DROP TYPE names
 * line up. Nothing anywhere in this repository has ever executed one. Twelve
 * inventory `.down.sql` files sat unrun, and the PRD's §12.10 "rollback
 * rehearsal" had nothing behind it at all.
 *
 * This runs them, in two tiers, because the two questions are different.
 *
 * TIER 1 — round trip, at the top of the chain.
 *   Rolling migration N back while N+1..head are applied is not a rehearsal of
 *   anything: the later migrations depend on what N built, so the failure it
 *   produces is about the ordering, not about the rollback. What can be
 *   rehearsed honestly is the contiguous suffix: take migrations from head
 *   downward for as long as each has a `.down.sql`, run each down, then run each
 *   forward again, and require the schema fingerprint to come back exactly.
 *   Nothing is left behind, so the database stays at head and the drill can be
 *   repeated.
 *
 * TIER 2 — dry run, inside a transaction that is rolled back.
 *   Every other inventory rollback file, executed against the live schema and
 *   then discarded. It cannot prove the reversal is correct at that point in
 *   history, but it does prove the statements parse, that every object they name
 *   exists, and that no later migration has made the file undroppable — which is
 *   the whole class of error a static check cannot see. A file that fails here
 *   is named with its SQLSTATE rather than being reported as a pass.
 *
 * Anti-vacuity, in three places, because a drill that silently rehearses nothing
 * is worse than no drill: a floor on how many rollback files must be found, a
 * requirement that each file contain a real DDL verb, and — for tier 1 — a
 * requirement that running the down actually CHANGED the fingerprint. A down
 * file that is a no-op passes every static check ever written.
 *
 * Usage:
 *   DATABASE_URL=... node src/scripts/rehearse-migration-rollback.mjs [--all] [--json]
 *   node src/scripts/rehearse-migration-rollback.mjs --self-test
 * Exit:
 *   0   every rehearsed rollback behaved
 *   1   a rollback failed, or fewer executed cleanly than the recorded baseline
 *   2   prerequisite unmet (no DATABASE_URL) or the walk found too little to trust
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { withDatabase } from "./cell-topology.mjs";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const MIGRATIONS = join(BACKEND_ROOT, "migrations");
const ROLLBACKS = join(MIGRATIONS, "rollback");

const argv = process.argv.slice(2);
const SELF_TEST = argv.includes("--self-test");
const ALL = argv.includes("--all");
const JSON_OUT = argv.includes("--json");
/** Rewrites DATABASE_URL onto another database, so CI can drill the cold-built cell. */
const DATABASE = (argv.find((a) => a.startsWith("--database=")) ?? "").slice("--database=".length);

/** A migration is inventory when its tag says so. Stated, not inferred. */
const INVENTORY_TAG = /^\d+[a-z]?_(inv_|inventory)/;

/** Floor on inventory rollback files. Below this the walk is broken, not clean. */
const MIN_INVENTORY_ROLLBACKS = 10;

/**
 * How many inventory `.down.sql` files execute cleanly against a head schema
 * today. Can only rise. Measured, never guessed — the first run of this drill is
 * where the number came from, and the eight that fail are named in the output
 * with the SQLSTATE that stopped them.
 */
const TIER2_CLEAN_BASELINE = 11;

/**
 * Rollback files that are known not to execute, with the SQLSTATE that stops
 * them. Printed on every run, never silent.
 *
 * A file that breaks and is NOT listed here fails the drill. A file that IS
 * listed and starts working also fails it, so the list cannot go stale — which
 * is the failure mode this whole ticket is about.
 */
const KNOWN_BROKEN = [
  {
    tag: "0909_build_common_actor_validate",
    code: "0A000",
    reason:
      "Its 29 statements are all `ALTER TABLE … ALTER CONSTRAINT … NOT VALID`, and PostgreSQL " +
      "refuses: ALTER CONSTRAINT can change deferrability and nothing else, so a validated " +
      "constraint cannot be un-validated. The file has never been able to run and never could. " +
      "Reversing 0909 properly means dropping and re-adding all 29 foreign keys NOT VALID, which " +
      "is a build change with its own risk, not an inventory one — recorded here rather than " +
      "guessed at. It is also why tier 1 cannot descend past 0910.",
  },
];

const DDL = /\b(ALTER|DROP|CREATE|TRUNCATE|UPDATE|DELETE|INSERT)\b/i;

/** Above this many rows a table is counted but not digested: a digest is a full scan. */
const DIGEST_ROW_CAP = 20_000;

/**
 * `-- @data-loss: table, table` in a `.down.sql`, naming what reversing it costs.
 *
 * Reversing an additive column is schema-reversible and not data-reversible: the
 * column comes back at its default and everything that was in it is gone. That
 * is not a defect, but it is not free either, and it must be a sentence somebody
 * wrote rather than a surprise during an incident. So the drill fails on
 * undeclared loss, and reports declared loss every run without failing.
 */
const DECLARED_LOSS = /--\s*@data-loss:\s*([^\n]+)/i;

function declaredLossTables(text) {
  const m = DECLARED_LOSS.exec(text);
  if (!m) return new Set();
  return new Set(
    m[1]
      .split(/[,\s]+/)
      .map((t) => t.trim().replace(/^"|"$/g, ""))
      .filter(Boolean),
  );
}

/** Thrown to make the driver discard a dry-run transaction. */
class Discard extends Error {}

function journalTags() {
  const path = join(MIGRATIONS, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8"));
  return [...journal.entries]
    .sort((a, b) => a.when - b.when || a.idx - b.idx)
    .map((e) => e.tag);
}

function statementsOf(text) {
  return text
    .split("--> statement-breakpoint")
    .flatMap((chunk) =>
      chunk.includes("--> statement-breakpoint") ? [chunk] : chunk.split(/;\s*\n(?=\s*(?:--|[A-Z]))/),
    )
    .map((s) => s.trim().replace(/;$/, "").trim())
    .filter((s) => s.length > 0 && DDL.test(s));
}

export function looksLikeARollback(text) {
  const statements = statementsOf(text);
  return statements.length > 0;
}

/**
 * Everything about the inventory schema a rollback could plausibly change:
 * columns and their nullability, indexes, constraints and policies.
 */
const FINGERPRINT = `
  SELECT string_agg(line, E'\\n' ORDER BY line) AS fp FROM (
    SELECT format('c %s.%s %s %s', table_name, column_name, data_type, is_nullable) AS line
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name LIKE 'inv\\_%'
    UNION ALL
    SELECT format('i %s %s', indexname, indexdef)
      FROM pg_indexes WHERE schemaname = 'public' AND tablename LIKE 'inv\\_%'
    UNION ALL
    SELECT format('k %s.%s %s', c.conrelid::regclass::text, c.conname, c.contype)
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname LIKE 'inv\\_%'
    UNION ALL
    SELECT format('p %s.%s', p.polrelid::regclass::text, p.polname)
      FROM pg_policy p JOIN pg_class t ON t.oid = p.polrelid
     WHERE t.relname LIKE 'inv\\_%'
  ) s`;

/**
 * Row counts per inventory table.
 *
 * A schema that comes back is not the same claim as a database that comes back.
 * 0910's rollback drops two columns; re-applying it brings them back at their
 * defaults, so a round trip over populated rows silently loses that grain. The
 * drill measures it rather than assuming, and — as important — prints how large
 * the dataset was, so a green here can never be read as a production-sized
 * rehearsal when it ran against an empty database.
 */
async function rowCensus(sql) {
  const tables = await sql.unsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'inv\\_%' ORDER BY 1`,
  );
  const counts = new Map();
  const digests = new Map();
  let total = 0;
  let undigested = 0;
  for (const { tablename } of tables) {
    const [row] = await sql.unsafe(`SELECT count(*)::bigint AS n FROM "${tablename}"`);
    const n = Number(row.n);
    counts.set(tablename, n);
    total += n;
    // The values, not just the count. Dropping a column and re-adding it keeps
    // every row and loses everything that was in it, which a row count cannot
    // see. Capped, because digesting a large table is a full scan and this drill
    // must stay runnable on a database that is not empty.
    if (n === 0 || n > DIGEST_ROW_CAP) {
      if (n > DIGEST_ROW_CAP) undigested++;
      continue;
    }
    const [d] = await sql.unsafe(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS d FROM "${tablename}" t`,
    );
    digests.set(tablename, d.d);
  }
  return { counts, digests, total, tables: tables.length, undigested };
}

async function fingerprint(sql) {
  const [row] = await sql.unsafe(FINGERPRINT);
  return row?.fp ?? "";
}

async function runStatements(executor, text, label) {
  for (const statement of statementsOf(text)) {
    try {
      await executor.unsafe(statement);
    } catch (error) {
      const code = error?.code ?? "unknown";
      const message = String(error?.message ?? error).split("\n")[0];
      throw Object.assign(new Error(`${label}: ${code} ${message}`), { code, statement });
    }
  }
}

function rollbackFilesFor(tags) {
  const present = new Set(
    existsSync(ROLLBACKS)
      ? readdirSync(ROLLBACKS)
          .filter((f) => f.endsWith(".down.sql"))
          .map((f) => f.slice(0, -".down.sql".length))
      : [],
  );
  return tags.filter((t) => present.has(t) && (ALL || INVENTORY_TAG.test(t)));
}

/** The contiguous run at the top of the journal where every tag has a rollback. */
function suffixWithRollbacks(tags) {
  const present = new Set(
    readdirSync(ROLLBACKS)
      .filter((f) => f.endsWith(".down.sql"))
      .map((f) => f.slice(0, -".down.sql".length)),
  );
  const out = [];
  for (let i = tags.length - 1; i >= 0; i--) {
    if (!present.has(tags[i])) break;
    out.push(tags[i]);
  }
  return out;
}

async function tierOne(sql, tags, findings) {
  const suffix = suffixWithRollbacks(tags);
  console.log(`\nTIER 1 — round trip on the ${suffix.length} migration(s) at the top of the chain`);
  if (suffix.length === 0) {
    console.log("  none: the head migration has no rollback file, so nothing can be round-tripped");
    findings.push("tier 1 rehearsed nothing — the head migration has no rollback file");
    return;
  }

  const before = await fingerprint(sql);
  const rowsBefore = await rowCensus(sql);
  console.log(
    `  dataset under rehearsal: ${rowsBefore.total} rows across ${rowsBefore.tables} inventory ` +
      `tables, ${rowsBefore.digests.size} of them digested` +
      (rowsBefore.undigested > 0 ? `, ${rowsBefore.undigested} too large to digest` : ""),
  );
  if (rowsBefore.total === 0)
    console.log("  (empty — this run rehearses the schema only, not what a rollback does to data)");
  const rolledBack = [];

  // Descend: each down is applied on top of the ones already reversed, which is
  // the only order in which reversing a migration means anything.
  for (const tag of suffix) {
    const down = readFileSync(join(ROLLBACKS, `${tag}.down.sql`), "utf8");
    try {
      await runStatements(sql, down, `${tag}.down.sql`);
    } catch (error) {
      const known = KNOWN_BROKEN.find((k) => k.tag === tag);
      if (known) {
        console.log(`  ${tag}  down: ${error.code ?? "?"} — known broken, descent stops here`);
      } else {
        findings.push(
          `${tag}.down.sql cannot execute: ${error.code ?? "?"} ${String(error.message).slice(0, 160)}`,
        );
        console.log(`  ${tag}  down: FAILED ${error.code ?? "?"} (finding) — descent stops here`);
      }
      break;
    }
    rolledBack.push(tag);
    const rolled = await fingerprint(sql);
    if (rolled === before) {
      findings.push(`${tag}.down.sql executed but changed no inventory schema object — it is a no-op`);
      console.log(`  ${tag}  down: NO-OP (finding)`);
    } else {
      console.log(`  ${tag}  down: applied, fingerprint changed`);
    }
  }

  // Ascend: put back exactly what came off, whether the descent finished or not.
  // A drill that leaves the database short of head is worse than no drill.
  for (const tag of [...rolledBack].reverse()) {
    const forward = readFileSync(join(MIGRATIONS, `${tag}.sql`), "utf8");
    try {
      await runStatements(sql, forward, `${tag}.sql (re-apply)`);
      console.log(`  ${tag}  forward: re-applied`);
    } catch (error) {
      findings.push(
        `${tag}.sql could not be re-applied after its own rollback: ${error.code ?? "?"} ` +
          `${String(error.message).slice(0, 160)} — the database is NOT back at head`,
      );
      console.log(`  ${tag}  forward: FAILED ${error.code ?? "?"} (finding)`);
    }
  }

  if (rolledBack.length === 0) {
    console.log("  round trip: nothing was reversed, so nothing was restored");
    return;
  }
  const rowsAfter = await rowCensus(sql);
  const lost = [...rowsBefore.counts.entries()]
    .filter(([t, n]) => (rowsAfter.counts.get(t) ?? 0) !== n)
    .map(([t, n]) => `${t} ${n} -> ${rowsAfter.counts.get(t) ?? "gone"}`);
  if (lost.length > 0) {
    findings.push(`the round trip changed row counts: ${lost.join("; ")}`);
    console.log(`  round trip: ROWS CHANGED (finding) — ${lost.join("; ")}`);
  }
  const declared = new Set();
  for (const tag of rolledBack)
    for (const t of declaredLossTables(readFileSync(join(ROLLBACKS, `${tag}.down.sql`), "utf8")))
      declared.add(t);

  const altered = [...rowsBefore.digests.entries()]
    .filter(([t, d]) => rowsAfter.digests.get(t) !== d)
    .map(([t]) => t);
  const undeclared = altered.filter((t) => !declared.has(t));
  const asDeclared = altered.filter((t) => declared.has(t));

  if (asDeclared.length > 0)
    console.log(
      `  round trip: data loss in ${asDeclared.join(", ")} — declared by the rollback file, ` +
        `observed exactly there`,
    );
  if (undeclared.length > 0) {
    findings.push(
      `the round trip kept every row but changed their contents in: ${undeclared.join(", ")} — ` +
        `a column dropped and re-added comes back at its default, and the values that were in ` +
        `it are gone. Undeclared: add "-- @data-loss: <tables>" to the rollback file if this is ` +
        `understood and accepted`,
    );
    console.log(`  round trip: UNDECLARED DATA LOSS (finding) — ${undeclared.join(", ")}`);
  }
  if (lost.length === 0 && altered.length === 0 && rowsBefore.total > 0)
    console.log(`  round trip: all ${rowsBefore.total} inventory rows survived, byte for byte`);

  const after = await fingerprint(sql);
  if (after !== before) {
    findings.push(
      "the round trip did not restore the schema: down then forward left the inventory " +
        "fingerprint different from where it started",
    );
    console.log("  round trip: FINGERPRINT DID NOT RETURN (finding)");
  } else {
    console.log(`  round trip: ${rolledBack.length} reversed and restored, fingerprint returned exactly`);
  }
}

async function tierTwo(sql, candidates, findings) {
  console.log(
    `\nTIER 2 — dry run of ${candidates.length} rollback file(s), each inside a transaction that is rolled back`,
  );
  const broken = new Map(KNOWN_BROKEN.map((k) => [k.tag, k]));
  let clean = 0;
  const workedAnyway = [];

  for (const tag of candidates) {
    const down = readFileSync(join(ROLLBACKS, `${tag}.down.sql`), "utf8");
    if (!looksLikeARollback(down)) {
      findings.push(`${tag}.down.sql contains no DDL statement — it cannot reverse anything`);
      console.log(`  ${tag}  EMPTY (finding)`);
      continue;
    }

    let outcome = { ok: false, code: "?", message: "", changed: false };
    try {
      await sql.begin(async (tx) => {
        const before = await fingerprint(tx);
        await runStatements(tx, down, `${tag}.down.sql`);
        const after = await fingerprint(tx);
        outcome = { ok: true, code: "", message: "", changed: after !== before };
        // Thrown, not `ROLLBACK`: the driver owns the transaction, and the way
        // to discard one is to make its callback fail. This tier asks whether
        // the file can execute against the live schema, not whether head should
        // change, so nothing here is ever kept.
        throw new Discard();
      });
    } catch (error) {
      if (!outcome.ok)
        outcome = {
          ok: false,
          code: error?.code ?? "?",
          message: String(error?.message ?? error).slice(0, 140),
          changed: false,
        };
    }

    if (outcome.ok) {
      clean++;
      if (broken.has(tag)) workedAnyway.push(tag);
      if (!outcome.changed) {
        findings.push(
          `${tag}.down.sql executes but changes nothing at head — every object it names is ` +
            `already gone, so it reverses nothing and would report success anyway`,
        );
        console.log(`  ${tag}  executes, but is a NO-OP at head (finding)`);
      } else {
        console.log(`  ${tag}  executes at head, and changes the schema`);
      }
      continue;
    }

    if (broken.has(tag)) {
      console.log(`  ${tag}  ${outcome.code} — known broken, see the list above`);
      continue;
    }
    findings.push(`${tag}.down.sql cannot execute: ${outcome.code} ${outcome.message}`);
    console.log(`  ${tag}  ${outcome.code} FAILED (finding)`);
  }

  console.log(`  ${clean} of ${candidates.length} execute cleanly against the head schema`);
  for (const tag of workedAnyway)
    findings.push(
      `${tag} is on the known-broken list but executed cleanly — delete the entry, a stale ` +
        `exemption is exactly what this drill exists to stop`,
    );
  if (clean < TIER2_CLEAN_BASELINE)
    findings.push(
      `only ${clean} inventory rollback files execute at head; the recorded baseline is ` +
        `${TIER2_CLEAN_BASELINE} and it can only rise`,
    );
  return clean;
}

async function main() {
  const raw = process.env.DATABASE_URL;
  const url = raw && DATABASE ? withDatabase(raw, DATABASE) : raw;
  if (!url) {
    process.stderr.write(
      "PREREQUISITE UNMET: DATABASE_URL is not set. This drill executes rollbacks against a real " +
        "database and refuses to pretend otherwise.\n",
    );
    process.exit(2);
  }

  const tags = journalTags();
  const candidates = rollbackFilesFor(tags);
  if (!ALL && candidates.length < MIN_INVENTORY_ROLLBACKS) {
    process.stderr.write(
      `ERROR (vacuity): found only ${candidates.length} inventory rollback files — expected at ` +
        `least ${MIN_INVENTORY_ROLLBACKS}. Refusing to report a clean rehearsal of nothing.\n`,
    );
    process.exit(2);
  }

  const sql = postgres(url, {
    prepare: false,
    max: 1,
    onnotice: () => undefined,
    ...(/\.neon\.tech/i.test(url) ? { ssl: "require" } : {}),
  });
  const findings = [];
  let clean = 0;
  try {
    console.log("drill:rollback — executing rollbacks, not counting files");
    console.log(`  ${tags.length} journalled migrations, ${candidates.length} with a rollback file`);
    console.log(`  ${KNOWN_BROKEN.length} known-broken rollback file(s), named here every run:`);
    for (const k of KNOWN_BROKEN) console.log(`    - ${k.tag} (${k.code}): ${k.reason}`);
    const suffix = suffixWithRollbacks(tags);
    await tierOne(sql, tags, findings);
    clean = await tierTwo(
      sql,
      candidates.filter((t) => !suffix.includes(t)),
      findings,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }

  if (JSON_OUT) console.log(JSON.stringify({ findings, clean }, null, 2));
  if (findings.length > 0) {
    console.log("");
    for (const f of findings) console.log(`  FINDING ${f}`);
    console.log(`\ndrill:rollback FAILED (${findings.length})`);
    process.exit(1);
  }
  console.log("\ndrill:rollback PASSED");
}

function selfTest() {
  console.log("rehearse-migration-rollback self-test");
  console.log("====================================");
  let passed = 0;
  let failed = 0;
  const check = (label, condition) => {
    if (condition) {
      passed++;
      console.log(`  ok   ${label}`);
    } else {
      failed++;
      console.log(`  FAIL ${label}`);
    }
  };

  check("a comment-only rollback is not a rollback", !looksLikeARollback("-- nothing here\n"));
  check("an empty rollback is not a rollback", !looksLikeARollback("   \n\n"));
  check(
    "a DROP TABLE rollback is a rollback",
    looksLikeARollback(`SET lock_timeout = '5s';\nDROP TABLE IF EXISTS "inv_x";`),
  );
  check(
    "statements split on the breakpoint marker",
    statementsOf(`ALTER TABLE a DROP COLUMN b;\n--> statement-breakpoint\nDROP INDEX c;`).length === 2,
  );
  check(
    "statements split on bare semicolons too, for the older files",
    statementsOf(`SET lock_timeout = '5s';\nALTER TABLE a DROP COLUMN b;\nDROP INDEX c;`).length === 2,
  );
  check("the journal is readable and non-trivial", journalTags().length > 500);
  check(
    "the inventory tag rule selects inventory and nothing else",
    INVENTORY_TAG.test("0911_inv_projects_rls") &&
      INVENTORY_TAG.test("0516_inventory_soft_delete") &&
      !INVENTORY_TAG.test("0477_invoice_items_backfill") &&
      !INVENTORY_TAG.test("0346_invitation_events"),
  );
  check(
    `at least ${MIN_INVENTORY_ROLLBACKS} inventory rollback files exist`,
    rollbackFilesFor(journalTags()).length >= MIN_INVENTORY_ROLLBACKS,
  );
  check(
    "a data-loss declaration names its tables",
    (() => {
      const t = declaredLossTables("-- @data-loss: inv_quality_holds, inv_x\nDROP TABLE y;");
      return t.size === 2 && t.has("inv_quality_holds") && t.has("inv_x");
    })(),
  );
  check(
    "a rollback with no declaration declares no loss",
    declaredLossTables('DROP TABLE IF EXISTS "inv_x";').size === 0,
  );
  check(
    "0910 declares the loss the drill measured",
    declaredLossTables(
      readFileSync(join(ROLLBACKS, "0910_inv_quality_hold_stock_grain.down.sql"), "utf8"),
    ).has("inv_quality_holds"),
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

if (SELF_TEST) selfTest();
else await main();
