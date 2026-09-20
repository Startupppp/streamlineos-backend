/**
 * The gate for the defect class 0770 swept once and 0923/0927 immediately
 * reintroduced: an `ON DELETE SET NULL` that writes a non-nullable column.
 *
 * Two halves, because neither alone is sufficient.
 *
 * The declaration half lives in `set-null-column-lists.spec.ts` and runs in the
 * default hermetic suite. It catches the one shape Drizzle can express and get
 * wrong — a SET NULL foreign key with no nullable member at all — at the moment
 * the schema is edited, before any migration is written.
 *
 * The catalog half needs a bootstrapped database, because the column list lives
 * only in `pg_constraint.confdelsetcols`. Drizzle cannot declare it and
 * drizzle-kit cannot introspect it: it reads
 * `information_schema.referential_constraints.delete_rule`, which answers
 * "SET NULL" for the correct form and the broken form alike. So no static check
 * over the schema files can see this, and the catalog has to be asked.
 *
 * Run it against a bootstrapped target:
 *   SET_NULL_GATE_DATABASE_URL=postgresql://… \
 *     npx jest src/db/schema/set-null-column-lists.db.spec.ts --maxWorkers=1
 */
import postgres from "postgres";
import * as schema from ".";
import {
  deriveSetNullDeclarations,
  SET_NULL_COLUMN_SETS_QUERY,
  UNREACHABLE_SET_NULL_QUERY,
} from "./set-null-column-lists";

const GATE_URL = process.env.SET_NULL_GATE_DATABASE_URL;

type UnreachableRow = {
  schema: string;
  table: string;
  constraint_name: string;
  definition: string;
};

type ColumnSetRow = {
  schema: string;
  table: string;
  constraint_name: string;
  key_columns: string[];
  set_null_columns: string[];
};

const declarations = () => deriveSetNullDeclarations(schema as Record<string, unknown>);

/**
 * Known SET NULL foreign keys that write a non-nullable column.
 *
 * These are composite FKs whose ON DELETE SET NULL carries no explicit column
 * list, so Postgres falls back to nulling ALL FK columns — including the
 * NOT NULL org_id. Any parent delete would raise 23502 rather than clearing
 * only the nullable pointer. They are excluded here because they fall in the
 * CRM and Inventory modules, which are outside the scope of the current lane.
 *
 * The list must stay exact: a new violation that is not named here will fail
 * the test, and fixing one of these should shrink the list in the same PR.
 */
const EXCLUDED_UNREACHABLE: readonly string[] = [
  "build.feedback_posts.fk_feedback_posts_crm_contact_party_id — FOREIGN KEY (org_id, crm_contact_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL",
  "build.feedback_posts.fk_feedback_posts_crm_organization_party_id — FOREIGN KEY (org_id, crm_organization_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL",
  "build.feedbucket_submissions.fk_feedbucket_submissions_crm_contact_party_id — FOREIGN KEY (org_id, crm_contact_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL",
  "build.feedbucket_submissions.fk_feedbucket_submissions_crm_organization_party_id — FOREIGN KEY (org_id, crm_organization_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL",
  "build.tickets.fk_tickets_customer_org_party_id — FOREIGN KEY (org_id, customer_org_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL",
  "build.tickets.fk_tickets_customer_party_id — FOREIGN KEY (org_id, customer_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL",
  "public.inv_packages.fk_inv_packages_so_id_org — FOREIGN KEY (org_id, so_id) REFERENCES inv_sales_orders(org_id, id) ON DELETE SET NULL",
  "public.inv_sales_orders.fk_inv_sales_orders_channel_id_org — FOREIGN KEY (org_id, channel_id) REFERENCES inv_channels(org_id, id) ON DELETE SET NULL",
  "public.inv_stock_adjustments.fk_inv_stock_adjustments_scrap_location_id_org — FOREIGN KEY (org_id, scrap_location_id) REFERENCES inv_locations(org_id, id) ON DELETE SET NULL",
];

/**
 * Known column-list mismatches between the catalog and the declaration.
 *
 * Two categories:
 *
 * 1. Inventory (excluded scope). The FK migrations that added these composite
 *    keys omitted the explicit SET NULL column list, so `confdelsetcols` is
 *    NULL and the query falls back to ALL conkey columns — including the NOT
 *    NULL org_id. The declaration (correctly) names only the nullable column in
 *    setNullColumns, producing a mismatch. These are the same FKs listed in
 *    EXCLUDED_UNREACHABLE above.
 *
 * 2. audit_logs.fk_audit_logs_org_actor_membership. The live constraint carries
 *    `ON DELETE SET NULL (actor_membership_id)` — correct behavior. The
 *    composite declaration includes org_id (which is nullable by column
 *    definition, since platform events carry NULL org_id), so
 *    deriveSetNullDeclarations includes org_id in setNullColumns. Drizzle
 *    provides no way to express a partial column list; the live catalog is
 *    authoritative and correct. The declaration is kept composite to accurately
 *    model the tenant-binding FK shape.
 */
const EXCLUDED_COLUMN_LIST_MISMATCHES: readonly string[] = [
  "public.audit_logs.fk_audit_logs_org_actor_membership: catalog nulls [actor_membership_id], declaration implies [actor_membership_id, org_id]",
  "public.inv_sales_orders.fk_inv_sales_orders_channel_id_org: catalog nulls [channel_id, org_id], declaration implies [channel_id]",
  "public.inv_stock_adjustments.fk_inv_stock_adjustments_scrap_location_id_org: catalog nulls [org_id, scrap_location_id], declaration implies [scrap_location_id]",
];

describe("ON DELETE SET NULL column lists in pg_catalog", () => {
  let sql: postgres.Sql;

  beforeAll(() => {
    if (!GATE_URL) throw new Error("SET_NULL_GATE_DATABASE_URL is required");
    sql = postgres(GATE_URL, { max: 1, prepare: false, onnotice: () => {} });
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it("has no SET NULL foreign key that writes a non-nullable column", async () => {
    const rows = await sql.unsafe<UnreachableRow[]>(UNREACHABLE_SET_NULL_QUERY);
    const offenders = rows.map(
      (row) => `${row.schema}.${row.table}.${row.constraint_name} — ${row.definition}`,
    );
    const inScope = offenders.filter((o) => !EXCLUDED_UNREACHABLE.includes(o));
    const excluded = offenders.filter((o) => EXCLUDED_UNREACHABLE.includes(o));
    expect(inScope).toEqual([]);
    expect(excluded.sort()).toEqual([...EXCLUDED_UNREACHABLE].sort());
  });

  it("carries the column list the declaration's nullability implies", async () => {
    const rows = await sql.unsafe<ColumnSetRow[]>(SET_NULL_COLUMN_SETS_QUERY);
    const live = new Map(
      rows.map((row) => [`${row.schema}.${row.table}.${row.constraint_name}`, row]),
    );

    const mismatches: string[] = [];
    for (const fk of declarations().declared) {
      const key = `${fk.schema}.${fk.table}.${fk.constraint}`;
      const row = live.get(key);
      if (!row) continue;
      const expected = [...fk.setNullColumns].sort();
      const actual = [...(row.set_null_columns ?? [])].sort();
      if (expected.join(",") !== actual.join(","))
        mismatches.push(`${key}: catalog nulls [${actual.join(", ")}], declaration implies [${expected.join(", ")}]`);
    }
    const inScope = mismatches.filter((m) => !EXCLUDED_COLUMN_LIST_MISMATCHES.includes(m));
    const excluded = mismatches.filter((m) => EXCLUDED_COLUMN_LIST_MISMATCHES.includes(m));
    expect(inScope).toEqual([]);
    expect(excluded.sort()).toEqual([...EXCLUDED_COLUMN_LIST_MISMATCHES].sort());
  });

  it("reaches the constraints it is meant to police", async () => {
    const rows = await sql.unsafe<ColumnSetRow[]>(SET_NULL_COLUMN_SETS_QUERY);
    expect(rows.length).toBeGreaterThan(100);
  });
});
