/**
 * No relationship may be enforced twice.
 *
 * WHAT WAS WRONG. Two authorities wrote the same foreign keys under different names —
 * Drizzle's `<child>_<col>_<parent>_<parentcol>_fk` for an inline `.references()`,
 * Postgres' own `<child>_<col>_fkey`, and repair migrations that walked the catalog
 * adding `<child>_org_id_fk` or `fk_<child>_org` by hand. 0320_recon_phase_a_orgid.sql
 * shows the mechanism: its loop guards only on the NAME it is about to use
 * (`IF NOT EXISTS (... WHERE conname=fkname ...)`) and never on whether an equivalent
 * foreign key on that column is already there, so it added a second identical one
 * wherever one existed under another name.
 *
 * Measured at journal head 677 across all 1,677 single-column foreign keys: 22
 * constraints formed 11 exact-duplicate pairs. Postgres installs referential-integrity
 * triggers per CONSTRAINT, so it reports the cost in its own words — one INSERT into
 * fin_reimbursement_batches fired ten RI triggers, three of them duplicates worth
 * 0.517 ms of a 4.905 ms execution, and every DELETE FROM organizations ran two
 * identical CASCADE passes over each of nine child tables. Migration 1056 drops the
 * eleven redundant constraints.
 *
 * WHY THIS SPEC EXISTS RATHER THAN A UNIT TEST. Nothing in TypeScript can see it. The
 * duplicate is a second row in pg_constraint under a name no declaration mentions, and
 * check:declaration-constraint-drift matches foreign keys by NAME ONLY — the extra name
 * lands in "live-but-undeclared" (1,187 objects), which that gate reports and never
 * fails. Only the catalog knows, so this runs against the catalog.
 *
 *   FK_PROBE_DATABASE_URL=postgresql://… \
 *     npx jest --config jest-db.json --runInBand --testPathPattern="duplicate-foreign-keys"
 */
import postgres from "postgres";

const DB_URL = process.env.FK_PROBE_DATABASE_URL ?? process.env.APP_DATABASE_URL;

/**
 * The grouping key is every column pg_constraint uses to define a foreign key's
 * behaviour. Two rows that agree on all of them are the same relationship enforced
 * twice: neither can reject a row the other accepts.
 */
const DUPLICATE_GROUPS = `
  SELECT n.nspname AS nsp,
         r.relname AS child,
         array_agg(c.conname ORDER BY c.conname) AS names
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
   WHERE c.contype = 'f'
     AND array_length(c.conkey, 1) = 1
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   GROUP BY n.nspname, r.relname, c.conrelid, c.confrelid, c.conkey, c.confkey,
            c.confupdtype, c.confdeltype, c.confmatchtype, c.condeferrable,
            c.condeferred, c.convalidated, c.confdelsetcols
  HAVING count(*) > 1
   ORDER BY 1, 2`;

describe("duplicate foreign keys", () => {
  let client: postgres.Sql;

  beforeAll(() => {
    if (!DB_URL) throw new Error("duplicate-foreign-keys.db.spec.ts requires FK_PROBE_DATABASE_URL or APP_DATABASE_URL");
    client = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  it("the scan reaches the whole catalog, so an empty result means clean and not broken", async () => {
    const [row] = await client<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
       WHERE c.contype = 'f'
         AND array_length(c.conkey, 1) = 1
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')`;

    // 1,677 at head. A floor, not a target: a broken join would otherwise leave the
    // duplicate test below passing over nothing.
    expect(row?.n ?? 0).toBeGreaterThanOrEqual(1_500);
  });

  it("no single-column relationship is enforced by two identical foreign keys", async () => {
    const groups = await client.unsafe<Array<{ nsp: string; child: string; names: string[] }>>(
      DUPLICATE_GROUPS,
    );

    // Red before migration 1056: eleven groups, 22 constraints.
    expect(groups.map((g) => `${g.nsp}.${g.child}: ${g.names.join(" == ")}`)).toEqual([]);
  });

  it("the eleven relationships still exist — the duplicate went, the constraint stayed", async () => {
    const survivors = await client<Array<{ name: string }>>`
      SELECT c.conname AS name
        FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
       WHERE c.contype = 'f'
         AND (n.nspname, r.relname, c.conname) IN (
           ('build','project_members','project_members_org_id_organizations_id_fk'),
           ('build','project_template_tickets','project_template_tickets_org_id_organizations_id_fk'),
           ('public','exit_checklists','exit_checklists_org_id_organizations_id_fk'),
           ('public','feedback_cycle_responses','fk_feedback_cycle_responses_org'),
           ('public','fin_expense_policies','fin_expense_policies_org_id_organizations_id_fk'),
           ('public','fin_reimbursement_batches','fin_reimbursement_batches_org_id_organizations_id_fk'),
           ('public','fin_reimbursement_batches','fin_reimbursement_batches_created_by_users_id_fk'),
           ('public','fin_reimbursement_batches','fin_reimbursement_batches_approved_by_users_id_fk'),
           ('public','invitation_events','invitation_events_org_id_organizations_id_fk'),
           ('public','workflow_variables','workflow_variables_org_id_organizations_id_fk'),
           ('public','workflow_versions','workflow_versions_org_id_organizations_id_fk')
         )
         AND c.convalidated`;

    expect(survivors.length).toBe(11);
  });

  it("fin_reimbursement_batches carries one RI trigger per relationship, not two", async () => {
    // tgisinternal RI triggers are named RI_ConstraintTrigger_c_<oid>; counting them by
    // the constraint they belong to is the same thing EXPLAIN (ANALYZE) prints.
    const rows = await client<Array<{ name: string }>>`
      SELECT c.conname AS name
        FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
       WHERE r.relname = 'fin_reimbursement_batches'
         AND c.contype = 'f'
         AND array_length(c.conkey, 1) = 1
       ORDER BY c.conname`;

    expect(rows.map((row) => row.name)).toEqual([
      "fin_reimbursement_batches_approved_by_users_id_fk",
      "fin_reimbursement_batches_created_by_users_id_fk",
      "fin_reimbursement_batches_org_id_organizations_id_fk",
    ]);
  });
});
