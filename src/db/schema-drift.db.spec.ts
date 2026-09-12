import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { dbSpecClient, dbSpecSuite, dbSpecUrl } from "../test/db-spec-gate";

/**
 * Every table Drizzle declares has a table behind it.
 *
 * This is the guard for a failure that produced no error anywhere for months:
 * a `pgTable(...)` is added, the service that queries it is written, registered
 * and reachable, and the migration is never authored or never run. Nothing
 * fails. `tsc` is happy — the declaration is the type. The tests are happy —
 * they mock the database. The app boots and maps the routes. The first person
 * to learn is whoever calls the endpoint.
 *
 * `AutonomyRepairService` sat in that state with two tables that had no
 * migration at all, and eleven more tables had a migration that was journalled
 * and never applied. The journal is not evidence of anything: it listed 321
 * entries against 286 applied rows, and nothing compared the two.
 *
 * So this asks the database, not the journal.
 *
 * Deliberately a `.db.spec.ts` behind `dbSpecSuite`, for the same reason the
 * other database specs are: the hermetic `jest` run has no database and must
 * not start failing for the want of one. That makes it a check somebody has to
 * run rather than one that runs itself, which is weaker than it should be — but
 * a drift check that cannot reach the database can only compare the schema to
 * the migration text, and the whole lesson here is that the migration text is
 * not the state.
 */

const describeDb = dbSpecSuite();

/**
 * Declared and deliberately absent, with the authority that says so.
 *
 * These are NOT drift. `migrations/pending/hrms-phase1/README.md` says the
 * bundle is "review-only and not authorized for database execution until the
 * remaining rehearsal and execution gates pass", and its own note explains why
 * it cannot go through Drizzle at all: SQL-managed partition parents, reciprocal
 * deferred constraints, exclusion constraints and per-leaf triggers "cannot be
 * represented truthfully by the current Drizzle snapshot chain".
 *
 * That last part is why this list may only SHRINK, and only by that bundle's own
 * applier. Creating one of these from the Drizzle declaration would produce a
 * table with the right columns and none of the partitioning or triggers — close
 * enough to look applied, wrong enough that the real bundle could never land on
 * top of it. An entry leaves this list when `hrms:schema-bundle` puts the real
 * table there, never because somebody made the check go green.
 */
const PENDING_BY_DESIGN: readonly string[] = [
  // hrms-phase1/0000_hrms_profiles_workforce.sql
  "public.hr_employment_legacy_map",
  "public.hr_person_legacy_map",
  "public.hr_workforce_reconciliation_items",
  "public.hrms_migration_profile_events",
  "public.hrms_migration_profiles",
  "public.hrms_scope_versions",
  // hrms-phase1/0001_hrms_effective_history.sql
  "public.worker_assignment_periods",
  "public.worker_engagement_state_events",
  "public.worker_reporting_lines",
  // hrms-phase1/0002_hrms_leave_ledger.sql
  "public.worker_leave_balance_projections",
  "public.worker_leave_entry_locators",
  "public.worker_leave_ledger_entries",
  "public.worker_leave_reversal_links",
  // hrms-phase1/0003_hrms_attendance_events.sql
  "public.attendance_correction_links",
  "public.attendance_daily_projections",
  "public.attendance_event_evidence",
  "public.attendance_event_locators",
  "public.attendance_events",
  "public.attendance_evidence_legal_holds",
  "public.attendance_session_projections",
  // hrms-phase1/0004_hrms_hierarchy_audit.sql
  "public.hr_audit_event_sources",
  "public.hr_audit_events",
  "public.org_unit_closure",
];

/**
 * Every declared table, as `schema.table`.
 *
 * Qualified, not bare, and that is not tidiness. The declarations span five
 * Postgres schemas -- `public`, `build`, `build_events`, `app` -- and the first
 * version of this check compared bare names against `public` and `build` only.
 * It reported `build_events.ticket_comments` as missing while the table was
 * sitting there. A drift check that cries wolf gets muted, which costs more than
 * the drift it was watching for.
 *
 * Every schema file, walked directly rather than through the barrel.
 *
 * 23 of the tables this has to see are declared in files `db/schema/index.ts`
 * does not re-export, and they are not dead:
 * `hr/time/attendance-event-writer.service.ts` and
 * `organization/hierarchy/org-hierarchy-tree-source.service.ts` import them by
 * path. Reading the barrel would make exactly the tables most likely to drift
 * invisible to the check written to catch drift.
 */
function declaredTables(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) continue;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(full) as Record<string, unknown>;
      for (const value of Object.values(mod)) {
        if (!is(value, PgTable)) continue;
        const cfg = getTableConfig(value);
        names.add(`${cfg.schema ?? "public"}.${cfg.name}`);
      }
    }
  };
  walk(__dirname + "/schema");
  return names;
}

function connect() {
  // TLS follows the host (db-spec-gate): `ssl: "require"` was right for Neon
  // and fatal against the local Postgres the gate runs these on.
  return dbSpecClient(dbSpecUrl("DATABASE_URL"), {
    prepare: false,
    max: 2,
    connect_timeout: 30,
    onnotice: () => {},
  });
}

describeDb("the schema and the database agree about which tables exist", () => {
  let client: ReturnType<typeof connect>;
  let live: Set<string>;

  beforeAll(async () => {
    client = connect();
    /*
      Every non-system schema, rather than a list of the ones we remember. A
      schema this does not ask about is a schema whose tables all read as
      missing, and the answer to "which schemas are there" is in the database.
    */
    const rows = await client<{ schema: string; name: string }[]>`
      SELECT n.nspname::text AS schema, c.relname::text AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p')
         AND n.nspname NOT LIKE 'pg\\_%'
         AND n.nspname NOT IN ('information_schema', 'drizzle')
    `;
    live = new Set(rows.map((row) => `${row.schema}.${row.name}`));
  }, 60_000);

  afterAll(async () => {
    await client?.end();
  });

  it("has a table behind every table Drizzle declares", () => {
    const pending = new Set(PENDING_BY_DESIGN);
    const missing = [...declaredTables()]
      .filter((table) => !live.has(table) && !pending.has(table))
      .sort();

    /*
      A name here is a table the code can query and the database does not have.
      Find its migration and run it; if there is no migration, that is the bug —
      author one from the Drizzle declaration. Do NOT add the name to
      PENDING_BY_DESIGN: that list means "another applier owns this", and it has
      exactly one member set, named above with the document that authorises it.
    */
    expect(missing).toEqual([]);
  });

  it("keeps the pending list honest as the bundle lands", () => {
    const arrived = PENDING_BY_DESIGN.filter((table) => live.has(table));

    // These exist now, so the bundle ran — delete them from PENDING_BY_DESIGN.
    // A list of exceptions nobody prunes stops being a list of exceptions and
    // becomes a place names go to be forgotten.
    expect(arrived).toEqual([]);
  });

  it("still declares every table it has excused", () => {
    const declared = declaredTables();
    const gone = PENDING_BY_DESIGN.filter((table) => !declared.has(table));

    // An excused table that is no longer declared means the declaration was
    // deleted and this list was not. It is excusing nothing, and the next
    // reader has to work out which of the two is stale.
    expect(gone).toEqual([]);
  });
});
