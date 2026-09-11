/**
 * Who would LOSE access if a module gate moved, and who is refused today.
 *
 * READ ONLY. It runs four SELECTs and writes nothing, which is what makes it
 * safe to point at production — and pointing it at production is the entire
 * reason it exists as a script rather than a paste.
 *
 * ## The question it was written for
 *
 * All 13 controllers in `modules/timesheets` carry `@RequireModule("build")`,
 * while the module registry declares `timesheets` as its own plan-gated module
 * with its own route, product key and cache namespace. Measured on a fixture
 * org: with only Timesheets enabled the payroll export answers 402, and adding
 * Build makes it pass. So an org that buys Timesheets and not Build cannot
 * reach what it bought, and an org with Build gets Timesheets free.
 *
 * Flipping the decorator is one line. What makes it a decision rather than a
 * change is the third bucket below: every org holding `build` WITHOUT
 * `timesheets` loses access the moment it flips. That number is not knowable
 * from the code, only from the database in front of you — and the dev branch
 * and production will not agree.
 *
 * ## Reading the output
 *
 *   both        unaffected whichever way the gate goes
 *   a-only      LOSES ACCESS if the gate moves from A to B   <- the blast radius
 *   b-only      402s TODAY, would gain access                <- the people it is for
 *   neither     unaffected
 *
 * ## What it does NOT tell you, stated so a number is not over-read
 *
 * - It reports on the database you point it at and nothing else. Run it against
 *   production before touching a decorator; a clean result on the shared dev
 *   branch means only that the dev branch is clean. On 2026-09-10 that branch
 *   held 33 orgs whose a-only bucket was six dev fixtures — `test`,
 *   `My Organization` and the like — which says nothing about real tenants.
 * - `org_modules.enabled` is authoritative only for NON-CORE modules. `home`,
 *   `kb`, `chat`, `mail` and `calendar` are core and reachable with no row at
 *   all, so this census is meaningless for them and would report every org as
 *   "neither". `build` and `timesheets` are both plan-gated, which is why the
 *   row is the right source here.
 * - An org with no `org_modules` row for either module is counted as "neither",
 *   which is correct for a plan-gated module and wrong for a core one. See
 *   above.
 * - It counts ORGANISATIONS, not seats or revenue. Six orgs may be six trials
 *   or six enterprises; the names are printed so a human can tell.
 *
 * ## The mistake that cost a run
 *
 * The column is `enabled`. It is not `is_enabled`, which is what I wrote first,
 * and Postgres answered with a column-does-not-exist rather than a wrong number
 * — the good failure. `org_modules` is (org_id, module_key, enabled, ...) with a
 * unique index on the first two; see `db/schema/common/access.ts`.
 *
 *   node --env-file=.env src/scripts/census-module-entitlement.mjs
 *   node src/scripts/census-module-entitlement.mjs --url="$PROD_URL"
 *   node ... --module-a=build --module-b=timesheets --limit=50
 *   node src/scripts/census-module-entitlement.mjs --self-test   # no database
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const arg = (name, fallback) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const MODULE_A = arg("module-a", "build");
const MODULE_B = arg("module-b", "timesheets");
const LIMIT = Number(arg("limit", "40"));

/** Buckets a row set. Pure, so `--self-test` can exercise it with no database. */
export function bucket(rows) {
  return {
    both: rows.filter((r) => r.has_a && r.has_b),
    aOnly: rows.filter((r) => r.has_a && !r.has_b),
    bOnly: rows.filter((r) => !r.has_a && r.has_b),
    neither: rows.filter((r) => !r.has_a && !r.has_b),
  };
}

if (args.includes("--self-test")) {
  const rows = [
    { name: "both", has_a: true, has_b: true },
    { name: "a", has_a: true, has_b: false },
    { name: "b", has_a: false, has_b: true },
    { name: "none", has_a: false, has_b: false },
  ];
  const b = bucket(rows);
  const ok =
    b.both.length === 1 && b.aOnly.length === 1 && b.bOnly.length === 1 && b.neither.length === 1 &&
    b.aOnly[0].name === "a" && b.bOnly[0].name === "b" &&
    // every row lands in exactly one bucket, or a total is a lie
    b.both.length + b.aOnly.length + b.bOnly.length + b.neither.length === rows.length;
  console.log(ok ? "self-test OK — every row lands in exactly one bucket" : "self-test FAILED");
  process.exit(ok ? 0 : 1);
}

const url = arg("url", process.env.DATABASE_URL ?? process.env.DB);
if (!url) {
  // Exit 2 is PREREQUISITE UNMET in this repository, not "violation found".
  console.error("No database. Pass --url=... or set DATABASE_URL.");
  process.exit(2);
}

const sql = postgres(url, {
  prepare: false,
  max: 1,
  ssl: /[?&]sslmode=disable\b/.test(url) ? false : "require",
  onnotice: () => {},
});

try {
  const [{ current_database: db }] = await sql`SELECT current_database()`;
  const rows = await sql`
    SELECT o.id, o.name,
           bool_or(m.module_key = ${MODULE_A} AND m.enabled) AS has_a,
           bool_or(m.module_key = ${MODULE_B} AND m.enabled) AS has_b
    FROM organizations o
    LEFT JOIN org_modules m ON m.org_id = o.id
    GROUP BY o.id, o.name
    ORDER BY o.name`;

  const { both, aOnly, bOnly, neither } = bucket(rows);
  console.log(`database: ${db}   modules: ${MODULE_A} vs ${MODULE_B}`);
  console.log(`organizations: ${rows.length}`);
  console.log(`  ${MODULE_A} AND ${MODULE_B} : ${both.length}   (unaffected either way)`);
  console.log(`  ${MODULE_A}, NO ${MODULE_B} : ${aOnly.length}   <- LOSE ACCESS if the gate moves`);
  console.log(`  ${MODULE_B}, NO ${MODULE_A} : ${bOnly.length}   <- refused TODAY, would gain access`);
  console.log(`  neither                     : ${neither.length}`);

  const show = (label, list) => {
    if (!list.length) return;
    console.log(`\n${label}:`);
    for (const r of list.slice(0, LIMIT)) console.log(`  ${r.name ?? r.id}`);
    if (list.length > LIMIT) console.log(`  ... and ${list.length - LIMIT} more`);
  };
  show("would lose access", aOnly);
  show("refused today", bOnly);

  if (aOnly.length === 0) {
    console.log(`\nNobody holds ${MODULE_A} without ${MODULE_B} here, so the gate can move at no cost ON THIS DATABASE.`);
  }
} finally {
  await sql.end();
}
