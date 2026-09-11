#!/usr/bin/env node
/**
 * Gate: an applied migration's SQL may not change.
 *
 * WHAT IT IS FOR
 * --------------
 * `db-bootstrap.mjs` and `run-pending-migrations.mjs` both decide "already
 * applied" from the journal's `when`, so neither re-applies a migration whose
 * file was edited after it ran. That is the correct behaviour and it is also
 * silent: the warm database keeps the SQL as it was, a cold build from the same
 * journal gets the SQL as it now is, and the two databases are no longer the same
 * database. Nothing else in the repository can see that. `check:migration-chain`,
 * `check:migration-ledger`, `check:migration-discipline` and
 * `check:baseline-integrity` all exit 0 over an edited applied migration, because
 * none of them compares the file against anything it was before.
 *
 * `migrations/meta/_chain.sha256.json` is that "before". It is a committed seal of one
 * line per journal entry — the raw sha256 a runner records in
 * `drizzle.__drizzle_migrations`, and the COMMENT-STRIPPED hash beside it.
 *
 * WHY TWO HASHES
 * --------------
 * Because the two kinds of edit do not deserve the same answer, and the ledger
 * alone cannot tell them apart (it stores the raw hash only, so a runner can see
 * THAT a file changed and never whether the change was inert).
 *
 *   effective hash changed  → FAIL. The statements differ. A cold build and a warm
 *                             database now disagree about the schema.
 *   raw hash changed only   → WARN. Comments or whitespace. Every database built
 *                             from either version is identical; the seal is
 *                             refreshed by `--emit` without `--reseal`.
 *
 * The worked example this was written for: `1052_t07_roster_entries_natural_key.sql`
 * gained a `@data-loss` comment block after it had been applied. Its raw sha256
 * moved from 2f5709e78dd9ac9c… to 63b1e114626dc014…, so `pnpm db:bootstrap` on a
 * database at head found no matching hash and re-ran its DDL. Comment-only, so
 * this gate warns rather than fails — and had one statement moved with it, it
 * would have failed on the day of the edit.
 *
 * FOUR WAYS THIS MUST FAIL, all bite-proven in --self-test:
 *   1. a sealed entry whose effective SQL changed;
 *   2. a sealed entry whose journal `when` was renumbered — the join key moved,
 *      so the ledger row that prevents re-application no longer matches;
 *   3. a sealed entry whose journal entry is gone — otherwise deleting history
 *      from the journal is free;
 *   4. an unsealed entry appearing BELOW the seal's high-water mark — a new
 *      migration is appended above it, so anything else is a file that was
 *      renamed or back-dated into applied history.
 * And a fifth: an empty seal or an empty journal is a failure, not a pass.
 *
 * Flags:
 *   --emit      refresh the seal: append genuinely new entries, and accept
 *               comment-only changes. REFUSES a changed effective hash.
 *   --reseal    with --emit, also accept changed effective hashes. This is the
 *               deliberate act of saying "the database was rebuilt to match".
 *   --self-test fixture-driven proof that each failure above bites, then exit.
 *
 * Exit: 0 sealed and unchanged (warnings allowed) · 1 a seal is broken · 2 nothing to verify.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { effectiveHash, planMigrations, driftedEntries, sha256 } from "./migration-plan.mjs";

/**
 * Floor on the number of sealed entries. A seal that covers nothing passes
 * vacuously, which is the failure mode `gate-corpus.mjs` was written for. May
 * only rise: the journal is append-only.
 */
const MIN_SEALED_ENTRIES = 600;

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = join(SCRIPT_DIR, "../../migrations");
const JOURNAL_FILE = join(MIGRATIONS_DIR, "meta/_journal.json");
const SEAL_FILE = join(MIGRATIONS_DIR, "meta/_chain.sha256.json");

const EMIT = process.argv.includes("--emit");
const RESEAL = process.argv.includes("--reseal");
const SELF_TEST = process.argv.includes("--self-test");

/** One sealed record per journal entry, in journal order. */
export function sealFrom(entries, readMigration) {
  return entries.map((entry) => {
    const content = readMigration(entry.tag);
    return {
      tag: entry.tag,
      when: entry.when,
      sha256: sha256(content),
      effective: effectiveHash(content),
    };
  });
}

/**
 * Compare a journal against a seal.
 *
 * @returns { changed, renumbered, missing, backdated, commentOnly, added, highWater }
 */
export function compareSeal(entries, sealed, readMigration) {
  const sealedByTag = new Map(sealed.map((s) => [s.tag, s]));
  const journalByTag = new Map(entries.map((e) => [e.tag, e]));
  const highWater = sealed.length ? Math.max(...sealed.map((s) => Number(s.when))) : 0;

  const changed = [];
  const renumbered = [];
  const commentOnly = [];
  const added = [];
  const backdated = [];

  for (const entry of entries) {
    const seal = sealedByTag.get(entry.tag);
    if (!seal) {
      (Number(entry.when) > highWater ? added : backdated).push(entry);
      continue;
    }
    if (Number(seal.when) !== Number(entry.when))
      renumbered.push({ tag: entry.tag, sealed: seal.when, journal: entry.when });

    const content = readMigration(entry.tag);
    const nowEffective = effectiveHash(content);
    const nowRaw = sha256(content);
    if (nowEffective !== seal.effective)
      changed.push({ tag: entry.tag, sealed: seal.effective, now: nowEffective });
    else if (nowRaw !== seal.sha256)
      commentOnly.push({ tag: entry.tag, sealed: seal.sha256, now: nowRaw });
  }

  const missing = sealed.filter((s) => !journalByTag.has(s.tag)).map((s) => s.tag);

  return { changed, renumbered, missing, backdated, commentOnly, added, highWater };
}

// -- self-test ---------------------------------------------------------------

function runSelfTests() {
  const failures = [];
  const check = (label, ok) => {
    if (ok) return;
    failures.push(label);
  };

  const entries = [
    { tag: "0001_a", when: 100 },
    { tag: "0002_b", when: 200 },
  ];
  const files = {
    "0001_a": "CREATE TABLE a (id int);\n",
    "0002_b": "CREATE TABLE b (id int);\n",
  };
  const read = (tag) => files[tag];
  const baseline = sealFrom(entries, read);

  check("a seal over an unchanged journal reports nothing", (() => {
    const r = compareSeal(entries, baseline, read);
    return (
      r.changed.length === 0 &&
      r.renumbered.length === 0 &&
      r.missing.length === 0 &&
      r.backdated.length === 0 &&
      r.commentOnly.length === 0 &&
      r.added.length === 0
    );
  })());

  check("1. a changed STATEMENT is reported as changed", (() => {
    const edited = { ...files, "0002_b": "CREATE TABLE b (id bigint);\n" };
    const r = compareSeal(entries, baseline, (t) => edited[t]);
    return r.changed.length === 1 && r.changed[0].tag === "0002_b" && r.commentOnly.length === 0;
  })());

  check("a comment-only edit is reported as comment-only, NOT as changed", (() => {
    const edited = { ...files, "0002_b": `-- @data-loss note\n${files["0002_b"]}` };
    const r = compareSeal(entries, baseline, (t) => edited[t]);
    return r.commentOnly.length === 1 && r.changed.length === 0;
  })());

  check("2. a renumbered `when` is reported", (() => {
    const moved = [entries[0], { tag: "0002_b", when: 999 }];
    const r = compareSeal(moved, baseline, read);
    return r.renumbered.length === 1 && r.renumbered[0].tag === "0002_b";
  })());

  check("3. a sealed entry deleted from the journal is reported as missing", (() => {
    const r = compareSeal([entries[0]], baseline, read);
    return r.missing.length === 1 && r.missing[0] === "0002_b";
  })());

  check("4. an unsealed entry ABOVE the high-water mark is an ordinary addition", (() => {
    const grown = [...entries, { tag: "0003_c", when: 300 }];
    const files3 = { ...files, "0003_c": "CREATE TABLE c (id int);\n" };
    const r = compareSeal(grown, baseline, (t) => files3[t]);
    return r.added.length === 1 && r.backdated.length === 0;
  })());

  check("4. an unsealed entry BELOW the high-water mark is back-dated and is a failure", (() => {
    const grown = [{ tag: "0000_z", when: 50 }, ...entries];
    const files0 = { ...files, "0000_z": "CREATE TABLE z (id int);\n" };
    const r = compareSeal(grown, baseline, (t) => files0[t]);
    return r.backdated.length === 1 && r.backdated[0].tag === "0000_z" && r.added.length === 0;
  })());

  // -- migration-plan.mjs, bite-proven here because it is what this gate protects.
  check("planMigrations skips an EDITED already-applied migration", (() => {
    const ledger = [{ hash: sha256("the original text"), created_at: 200 }];
    const { apply, skip } = planMigrations(entries, ledger);
    return apply.length === 1 && apply[0].tag === "0001_a" && skip[0].tag === "0002_b";
  })());

  check("planMigrations applies an entry whose `when` has no ledger row", (() => {
    const { apply } = planMigrations(entries, [{ hash: "x", created_at: 100 }]);
    return apply.length === 1 && apply[0].tag === "0002_b";
  })());

  check("planMigrations does NOT skip a second migration with identical content", (() => {
    const twins = [
      { tag: "0001_t", when: 100 },
      { tag: "0002_t", when: 200 },
    ];
    const ledger = [{ hash: sha256(files["0001_a"]), created_at: 100 }];
    const { apply } = planMigrations(twins, ledger);
    return apply.length === 1 && apply[0].tag === "0002_t";
  })());

  check("driftedEntries names a skipped file that no longer matches the ledger", (() => {
    const ledger = [
      { hash: sha256(files["0001_a"]), created_at: 100 },
      { hash: sha256("stale text"), created_at: 200 },
    ];
    const { skip } = planMigrations(entries, ledger);
    const drift = driftedEntries(skip, ledger, read);
    return drift.length === 1 && drift[0].tag === "0002_b";
  })());

  check("driftedEntries is silent when every skipped file still matches", (() => {
    const ledger = entries.map((e) => ({ hash: sha256(files[e.tag]), created_at: e.when }));
    const { skip } = planMigrations(entries, ledger);
    return driftedEntries(skip, ledger, read).length === 0;
  })());

  check("the entry floor would reject this fixture seal", baseline.length < MIN_SEALED_ENTRIES);

  if (failures.length > 0) {
    console.error(`check-migration-immutability self-tests: ${failures.length} failed`);
    for (const f of failures) console.error(`  FAIL  ${f}`);
    process.exit(1);
  }
  console.log("check-migration-immutability self-tests: 13 passed");
}

if (SELF_TEST) {
  runSelfTests();
  process.exit(0);
}

// -- run ---------------------------------------------------------------------

const journal = JSON.parse(readFileSync(JOURNAL_FILE, "utf8"));
const entries = journal.entries ?? [];
const readMigration = (tag) => readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");

if (entries.length === 0) {
  process.stderr.write("INCONCLUSIVE — the journal holds 0 entries, so a clean result proves nothing\n");
  process.exit(2);
}

if (EMIT && !existsSync(SEAL_FILE)) {
  writeFileSync(
    SEAL_FILE,
    `${JSON.stringify(
      {
        note: "Seal of every journalled migration: sha256 of the file, and `effective` = sha256 of the same file with -- comments and whitespace removed. check:migration-immutability fails when `effective` moves, because a warm database and a cold build then disagree. Refresh with `pnpm check:migration-immutability:emit`; that refuses a changed `effective` without --reseal.",
        sealedAt: new Date().toISOString().slice(0, 10),
        entries: sealFrom(entries, readMigration),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Seal written: ${entries.length} entries.`);
  process.exit(0);
}

if (!existsSync(SEAL_FILE)) {
  process.stderr.write(
    `INCONCLUSIVE — no seal at ${SEAL_FILE}. Run \`pnpm check:migration-immutability:emit\` once to create it.\n`,
  );
  process.exit(2);
}

const seal = JSON.parse(readFileSync(SEAL_FILE, "utf8"));
const sealed = seal.entries ?? [];

if (sealed.length < MIN_SEALED_ENTRIES) {
  process.stderr.write(
    `INCONCLUSIVE — the seal covers ${sealed.length} entries, below the floor of ${MIN_SEALED_ENTRIES}. A seal that covers almost nothing passes vacuously.\n`,
  );
  process.exit(2);
}

const result = compareSeal(entries, sealed, readMigration);

console.log(
  `check-migration-immutability: ${sealed.length} sealed entries against a journal of ${entries.length} — ${result.added.length} newly appended, ${result.commentOnly.length} comment-only edit(s)`,
);

if (EMIT) {
  if (result.changed.length > 0 && !RESEAL) {
    console.error(
      `\nREFUSING to re-seal: ${result.changed.length} sealed migration(s) changed their STATEMENTS, not just their comments:`,
    );
    for (const c of result.changed) console.error(`  ${c.tag}`);
    console.error(
      "\nRe-sealing here would record the new SQL as if it had always been there, and every database\n" +
        "already carrying the old SQL would stay wrong and stay invisible. Either revert the edit and add\n" +
        "a NEW journalled migration, or rebuild the affected databases and re-run with --reseal.",
    );
    process.exit(1);
  }
  writeFileSync(
    SEAL_FILE,
    `${JSON.stringify(
      { ...seal, sealedAt: new Date().toISOString().slice(0, 10), entries: sealFrom(entries, readMigration) },
      null,
      2,
    )}\n`,
  );
  console.log(
    `Seal refreshed: ${entries.length} entries (${result.added.length} added, ${result.commentOnly.length} comment-only, ${RESEAL ? result.changed.length : 0} re-sealed).`,
  );
  process.exit(0);
}

const failures = [];

if (result.changed.length > 0) {
  console.error(`\nCHANGED after sealing — the statements differ, so a cold build and a warm database disagree:`);
  for (const c of result.changed)
    console.error(`  ${c.tag}  effective ${String(c.sealed).slice(0, 12)} -> ${String(c.now).slice(0, 12)}`);
  failures.push(`${result.changed.length} sealed migration(s) changed their SQL`);
}

if (result.renumbered.length > 0) {
  console.error(`\nRENUMBERED — \`when\` is the key every runner and every ledger row joins on:`);
  for (const r of result.renumbered)
    console.error(`  ${r.tag}  sealed when=${r.sealed}  journal when=${r.journal}`);
  failures.push(`${result.renumbered.length} renumbered journal entry(ies)`);
}

if (result.missing.length > 0) {
  console.error(`\nMISSING from the journal — the file was applied and its entry later removed:`);
  for (const m of result.missing) console.error(`  ${m}`);
  failures.push(`${result.missing.length} sealed entry(ies) no longer in the journal`);
}

if (result.backdated.length > 0) {
  console.error(
    `\nBACK-DATED — an unsealed entry sitting BELOW the sealed high-water mark of ${result.highWater}. A new migration is appended above it; anything else was renamed or back-dated into applied history:`,
  );
  for (const b of result.backdated) console.error(`  ${b.tag} (when=${b.when})`);
  failures.push(`${result.backdated.length} back-dated journal entry(ies)`);
}

if (result.commentOnly.length > 0) {
  console.warn(
    `\nCOMMENT-ONLY edits to already-sealed migrations (every database built from either version is identical; refresh with \`pnpm check:migration-immutability:emit\`):`,
  );
  for (const c of result.commentOnly) console.warn(`  ${c.tag}`);
}

if (failures.length > 0) {
  console.error(`\nFAIL — ${failures.length} seal violation(s):`);
  for (const f of failures) console.error(`  • ${f}`);
  process.exit(1);
}

console.log("\nOK — every sealed migration still builds the same database.");
process.exit(0);
