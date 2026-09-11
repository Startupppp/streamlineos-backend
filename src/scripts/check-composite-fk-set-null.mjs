/**
 * A foreign key may not declare ON DELETE SET NULL over a NOT NULL column.
 *
 * Postgres's bare `ON DELETE SET NULL` nulls EVERY column of the key. On a
 * tenant-composite key `(org_id, <x>_id)` that means it emits
 *
 *   UPDATE ONLY <child> SET "org_id" = NULL, "<x>_id" = NULL WHERE ...
 *
 * and `org_id` is NOT NULL, so the parent DELETE aborts with a not-null
 * violation on the CHILD table. The constraint can never fire the action it
 * declares. Nothing catches it at write time: the DDL is accepted, the
 * constraint validates, and every read behaves normally. It surfaces only on a
 * hard delete of the parent — and parents here are normally soft-deleted, so
 * the one path that reaches it is DPDP/GDPR erasure, which is exactly the path
 * that must not fail. 0662 repaired 37 of these; this gate stops them coming
 * back. See 0662's header for the two correct repairs.
 *
 * Postgres 15's column-list form `ON DELETE SET NULL (<column>)` nulls only the
 * named columns, which is how a composite key expresses "null the pointer, keep
 * the tenant". This gate reads `confdelsetcols` and accepts that form, so the
 * rule is precisely: every column the action would actually null must be
 * nullable.
 *
 * Usage:  node src/scripts/check-composite-fk-set-null.mjs [--self-test]
 * Env:    DATABASE_URL, or APP_DATABASE_URL — either role can read pg_catalog
 * Exit:   0 clean · 1 a key would null a NOT NULL column · 2 prerequisite unmet
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as dotenv from "dotenv";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
dotenv.config({ path: resolve(BACKEND_ROOT, ".env") });

/**
 * Keys that carry the defect and are not this repair's to change, each with the
 * owner who must decide and the reason it was left.
 *
 * This map is not an excuse list. An entry that no longer matches a live key is
 * a FAILURE, not a pass — otherwise a fixed key leaves its exemption behind and
 * the map silently re-authorises the next occurrence on that name.
 */
export const KNOWN_UNFIXED = new Map([
  // build module — reported to its owner; src/modules/build/** is out of scope here.
  ["fk_tickets_customer_party_id", "build.tickets → business_parties; owner: build"],
  ["fk_tickets_customer_org_party_id", "build.tickets → business_parties; owner: build"],
  ["fk_feedback_posts_crm_contact_party_id", "build.feedback_posts → business_parties; owner: build"],
  ["fk_feedback_posts_crm_organization_party_id", "build.feedback_posts → business_parties; owner: build"],
  ["fk_feedbucket_submissions_crm_contact_party_id", "build.feedbucket_submissions → business_parties; owner: build"],
  ["fk_feedbucket_submissions_crm_organization_party_id", "build.feedbucket_submissions → business_parties; owner: build"],
  // The seven arity-1 keys to global `users` that used to sit here — five hr_*,
  // two sign_* — are GONE as of 2026-09-10, verified against pg_catalog rather
  // than taken from this gate's own word: six of the constraints no longer
  // exist at all, and `hr_safety_incidents_reported_by_users_id_fk` now carries
  // NO ACTION (`confdeltype='a'`), which is the correct repair for anything on
  // the DPDP path — a database-level SET NULL there would perform a disposition
  // `subject-request-plan.ts` requires to be declared per table.
  //
  // Removed rather than left, because the docblock above means it: a stale
  // entry is a FAILURE, and it re-authorises the next occurrence on that name.
]);

/**
 * A foreign key's ON DELETE SET NULL nulls `confdelsetcols` when that list is
 * present, and the whole key when it is not. Everything else is derived here.
 */
export function classify(rows, known = KNOWN_UNFIXED) {
  const violations = [];
  for (const row of rows) {
    const nulled = row.setNullColumns ?? row.keyColumns;
    const offending = nulled.filter((c) => row.notNullColumns.includes(c));
    if (offending.length === 0) continue;
    violations.push({ ...row, offending });
  }
  const seen = new Set(violations.map((v) => v.name));
  return {
    unexpected: violations.filter((v) => !known.has(v.name)),
    accepted: violations.filter((v) => known.has(v.name)),
    stale: [...known.keys()].filter((n) => !seen.has(n)),
  };
}

const QUERY = `
  SELECT c.conname AS name,
         (SELECT n.nspname || '.' || cl.relname
            FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
           WHERE cl.oid = c.conrelid) AS "table",
         pg_get_constraintdef(c.oid) AS definition,
         (SELECT array_agg(a.attname ORDER BY k.ord)
            FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS "keyColumns",
         (SELECT array_agg(a.attname ORDER BY k.ord)
            FROM unnest(c.confdelsetcols) WITH ORDINALITY k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS "setNullColumns",
         (SELECT coalesce(array_agg(a.attname), '{}')
            FROM unnest(c.conkey) k(attnum)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
           WHERE a.attnotnull) AS "notNullColumns"
    FROM pg_constraint c
   WHERE c.contype = 'f' AND c.confdeltype = 'n'
   ORDER BY 2, 1
`;

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const url = process.env.DATABASE_URL ?? process.env.APP_DATABASE_URL;
  if (!url) {
    process.stderr.write(
      "PREREQUISITE UNMET — no database connection.\n" +
        "This gate reads pg_constraint, which only the live catalog can answer:\n" +
        "the defect is a property of the installed constraint, and a migration can\n" +
        "install a shape no schema file describes (0619 did exactly that).\n" +
        "Set DATABASE_URL or APP_DATABASE_URL. Either role can read pg_catalog.\n",
    );
    process.exit(2);
  }

  const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  let rows;
  try {
    rows = await sql.unsafe(QUERY);
  } catch (err) {
    process.stderr.write(`PREREQUISITE UNMET — cannot read pg_constraint: ${err.message}\n`);
    await sql.end({ timeout: 5 });
    process.exit(2);
  }
  await sql.end({ timeout: 5 });

  // Anti-vacuity. A schema with no SET NULL foreign key at all is not a clean
  // schema, it is a query that matched nothing — an empty result must never be
  // reported as a pass.
  if (rows.length === 0) {
    process.stderr.write(
      "PREREQUISITE UNMET — the catalog reports zero ON DELETE SET NULL foreign keys.\n" +
        "This database has hundreds. A zero result means the connection reached an\n" +
        "empty or unmigrated database, not that the schema is clean.\n",
    );
    process.exit(2);
  }

  const { unexpected, accepted, stale } = classify(rows);

  process.stdout.write(`ON DELETE SET NULL foreign keys read: ${rows.length}\n`);
  process.stdout.write(`Would null a NOT NULL column: ${unexpected.length + accepted.length}\n\n`);

  for (const v of accepted) {
    process.stdout.write(`  known   ${v.table}.${v.name}\n          ${KNOWN_UNFIXED.get(v.name)}\n`);
  }
  if (accepted.length > 0) process.stdout.write("\n");

  for (const v of unexpected) {
    process.stdout.write(
      `  VIOLATION  ${v.table}.${v.name}\n` +
        `             ${v.definition}\n` +
        `             would null NOT NULL column(s): ${v.offending.join(", ")}\n` +
        `             Deleting the referenced parent row aborts with a not-null\n` +
        `             violation on ${v.table}. Either name the nullable columns —\n` +
        `             ON DELETE SET NULL (${v.keyColumns.filter((c) => !v.notNullColumns.includes(c)).join(", ") || "<pointer>"}) —\n` +
        `             or drop the ON DELETE clause and clear children explicitly.\n`,
    );
  }
  for (const name of stale) {
    process.stdout.write(
      `  STALE      ${name} is in KNOWN_UNFIXED but no longer carries the defect.\n` +
        `             Remove it from the map; a leftover entry re-authorises the name.\n`,
    );
  }

  const failures = unexpected.length + stale.length;
  process.stdout.write(
    failures === 0
      ? `\nOK — ${accepted.length} known, 0 new.\n`
      : `\nFAIL — ${unexpected.length} new violation(s), ${stale.length} stale exemption(s).\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

function selfTest() {
  const cases = [
    {
      name: "bare SET NULL over a NOT NULL tenant column is a violation",
      rows: [{ name: "fk_x", table: "public.t", definition: "", keyColumns: ["org_id", "party_id"], setNullColumns: null, notNullColumns: ["org_id"] }],
      expect: (r) => r.unexpected.length === 1 && r.unexpected[0].offending.join() === "org_id",
    },
    {
      name: "column-list SET NULL naming only the nullable pointer is clean",
      rows: [{ name: "fk_x", table: "public.t", definition: "", keyColumns: ["org_id", "party_id"], setNullColumns: ["party_id"], notNullColumns: ["org_id"] }],
      expect: (r) => r.unexpected.length === 0 && r.accepted.length === 0,
    },
    {
      name: "column-list SET NULL naming a NOT NULL column is still a violation",
      rows: [{ name: "fk_x", table: "public.t", definition: "", keyColumns: ["org_id", "party_id"], setNullColumns: ["org_id"], notNullColumns: ["org_id"] }],
      expect: (r) => r.unexpected.length === 1,
    },
    {
      name: "single-column SET NULL over a NOT NULL column is a violation",
      rows: [{ name: "fk_x", table: "public.t", definition: "", keyColumns: ["created_by"], setNullColumns: null, notNullColumns: ["created_by"] }],
      expect: (r) => r.unexpected.length === 1,
    },
    {
      name: "a fully nullable key is clean",
      rows: [{ name: "fk_x", table: "public.t", definition: "", keyColumns: ["a", "b"], setNullColumns: null, notNullColumns: [] }],
      expect: (r) => r.unexpected.length === 0,
    },
    {
      name: "a known entry is accepted, not counted as new",
      rows: [{ name: "fk_known", table: "public.t", definition: "", keyColumns: ["org_id", "x"], setNullColumns: null, notNullColumns: ["org_id"] }],
      known: new Map([["fk_known", "owner: someone"]]),
      expect: (r) => r.unexpected.length === 0 && r.accepted.length === 1,
    },
    {
      name: "a known entry that no longer matches is stale",
      rows: [{ name: "fk_other", table: "public.t", definition: "", keyColumns: ["a"], setNullColumns: null, notNullColumns: [] }],
      known: new Map([["fk_gone", "owner: someone"]]),
      expect: (r) => r.stale.length === 1,
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const ok = c.expect(classify(c.rows, c.known ?? new Map()));
    if (!ok) failed++;
    process.stdout.write(`${ok ? "ok  " : "FAIL"}  ${c.name}\n`);
  }
  process.stdout.write(`\n${cases.length - failed}/${cases.length} passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(2);
});
