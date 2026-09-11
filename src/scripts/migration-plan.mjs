/**
 * What a migration runner must apply, decided the one way every runner here agrees on.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two supported runners read the SAME journal and used to disagree about what
 * "already applied" means:
 *
 *   run-pending-migrations.mjs:66   `journal.entries.filter(e => e.when > watermark)`
 *                                   — the TIMESTAMP, exactly as drizzle-kit decides it.
 *   db-bootstrap.mjs (before this)  `applied.has(sha256(fileContents))`
 *                                   — the CONTENT HASH.
 *
 * The two keys diverge the moment an already-applied migration file is edited:
 * its `when` is unchanged so the timestamp runner skips it, while its sha256 is
 * new so the hash runner runs its DDL a SECOND time against a database that
 * already has it. Measured against a real Postgres, a comment-only edit to an
 * applied migration made `pnpm db:bootstrap` abort with
 * `relation "probe_b" already exists` on a database that was already at head —
 * and where the DDL happens to be `IF NOT EXISTS`-guarded it does not abort, it
 * silently writes a SECOND ledger row for one journal entry and still prints
 * `RESULT: REACHED_HEAD`.
 *
 * check-migration-ledger.mjs's own docblock had already written the rule down:
 *
 *   "Hash is deliberately NOT the join key. Editing an applied migration changes
 *    its hash while the row stays valid, so a hash-keyed check reports live rows
 *    as orphans and would delete the only thing preventing re-application."
 *
 * So `created_at` (the journal entry's `when`) is the join key, here and
 * everywhere. Content hash is recorded, reported and compared — never used to
 * decide whether something ran.
 *
 * SET MEMBERSHIP, NOT A WATERMARK
 * -------------------------------
 * `planMigrations` asks whether THIS entry's `when` is in the ledger, not
 * whether it is above the maximum. That is deliberately a superset of the
 * watermark rule: a journal entry with no ledger row still applies even when a
 * LATER one already has. check-migration-ledger.mjs classifies exactly that hole
 * as SKIPPED — "it will never apply on this database, and nothing will ever say
 * so" — so the bootstrapper repairing it is the point of the bootstrapper. The
 * two runners now agree on every entry the watermark runner can see, and the
 * bootstrapper additionally fills the holes it cannot.
 *
 * DRIFT IS DETECTED, NOT ACTED ON
 * -------------------------------
 * Keying on `when` means an edited-after-apply migration is skipped instead of
 * re-run, which is correct and is also silent — the database keeps the old SQL
 * while the repository shows the new. `driftedEntries` names those, so the
 * runner can say so out loud. It compares the recorded sha256 against the file's
 * sha256; the ledger stores no second hash, so this cannot tell a comment-only
 * edit from a statement change. check-migration-immutability.mjs can, because it
 * keeps `effectiveHash` alongside the raw one in a committed manifest.
 */

import { createHash } from "node:crypto";

/** sha256 of exactly the bytes a runner would execute — the value both runners store. */
export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * The migration text with everything a database never sees removed: `--` line
 * comments and runs of whitespace.
 *
 * A `--` inside a string literal or a `$$ ... $$` body is stripped too. That is
 * acceptable and is why this value is named "effective" rather than "sql": it is
 * only ever compared against another value produced by this same function, never
 * executed and never shown to Postgres. What it buys is the distinction that
 * matters when a migration file changes after it was applied — a new comment
 * block leaves this hash alone, a changed statement does not.
 */
export function effectiveSql(content) {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

/** sha256 of `effectiveSql` — equal for two files that would build the same database. */
export function effectiveHash(content) {
  return sha256(effectiveSql(content));
}

/**
 * Split a journal into what must run and what already ran.
 *
 * @param entries    journal.entries, in journal order
 * @param ledgerRows rows of drizzle.__drizzle_migrations ({ hash, created_at })
 * @returns { apply, skip } — the same entry objects, partitioned, order preserved
 */
export function planMigrations(entries, ledgerRows) {
  const appliedWhen = new Set(ledgerRows.map((row) => String(row.created_at)));
  const apply = [];
  const skip = [];
  for (const entry of entries) {
    if (appliedWhen.has(String(entry.when))) skip.push(entry);
    else apply.push(entry);
  }
  return { apply, skip };
}

/**
 * Of the entries a run will SKIP, the ones whose file no longer hashes to what
 * this database recorded when it applied them.
 *
 * @param skipped  entries `planMigrations` put in `skip`
 * @param ledgerRows rows of drizzle.__drizzle_migrations ({ hash, created_at })
 * @param readFile   (tag) => file contents
 * @returns [{ tag, when, ledgerHash, fileHash }]
 */
export function driftedEntries(skipped, ledgerRows, readFile) {
  const hashByWhen = new Map(ledgerRows.map((row) => [String(row.created_at), row.hash]));
  const drifted = [];
  for (const entry of skipped) {
    const ledgerHash = hashByWhen.get(String(entry.when));
    if (!ledgerHash) continue;
    const fileHash = sha256(readFile(entry.tag));
    if (fileHash !== ledgerHash)
      drifted.push({ tag: entry.tag, when: entry.when, ledgerHash, fileHash });
  }
  return drifted;
}
