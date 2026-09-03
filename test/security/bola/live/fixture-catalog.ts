import type postgres from "postgres";
import type { TableRef } from "./param-tables";

/**
 * Real object ids, read out of the seeded database, for the tenants the sweep probes across.
 *
 * A BOLA probe is only meaningful against an id that EXISTS in the other organization: a random
 * uuid returns 404 from a correctly bound route and from a completely unbound one alike. So every
 * id here is a live primary key belonging to a named tenant, and the sweep's own-tenant control
 * proves the route can actually serve it before any cross-tenant answer is scored.
 */

export interface Catalog {
  /** `schema.table` -> primary-key column, for every org-scoped table with a single-column PK. */
  readonly tables: ReadonlyMap<string, TableRef>;
  /** `schema.table` for the tables holding at least one row for the source tenant. */
  readonly populated: ReadonlySet<string>;
  /** `schema.table` -> ids belonging to the source tenant, in primary-key order. */
  readonly ids: ReadonlyMap<string, readonly string[]>;
}

/**
 * The tenant column is not spelled one way in this schema.
 *
 * 767 tables call it `org_id` and 81 call it `organization_id` — `workers`, `subjects`,
 * `business_parties`, `issue_records`, `workflow_runs` and the whole `crm_*`/`party_*` family
 * among them. A catalog that looks only for `org_id` cannot produce an id for any route addressing
 * those, and their ~100 routes drop out of the sweep as "no table resolves this parameter" — an
 * absence that reads like a naming miss rather than the coverage hole it is. So the column name is
 * discovered per table and carried on the reference.
 */
const ORG_SCOPED_TABLES = `
SELECT n.nspname AS schema, c.relname AS name, pk.attname AS pk, o.attname AS org_column
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN LATERAL (
  SELECT a.attname
  FROM pg_index i
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
  WHERE i.indrelid = c.oid AND i.indisprimary AND array_length(i.indkey, 1) = 1
  LIMIT 1
) pk ON true
JOIN LATERAL (
  SELECT a.attname
  FROM pg_attribute a
  WHERE a.attrelid = c.oid AND NOT a.attisdropped AND a.attname IN ('org_id', 'organization_id')
  ORDER BY CASE a.attname WHEN 'org_id' THEN 0 ELSE 1 END
  LIMIT 1
) o ON true
WHERE c.relkind IN ('r', 'p')
  AND n.nspname IN ('public', 'build')
ORDER BY 1, 2`;

function quoted(table: TableRef): string {
  return `"${table.schema}"."${table.name}"`;
}

/**
 * Reads ids in batches rather than one statement per table.
 *
 * There are ~850 org-scoped tables here; a statement each is ~850 round trips per tenant and the
 * catalog read starts to dominate the sweep it exists to feed.
 */
/**
 * How many ids per table the pool holds.
 *
 * MEASURED, and it cost 83 routes: a control DELETE consumes its object, so each DELETE route
 * takes a fresh id from the back of its table's pool. At 24 the pool ran dry for every table
 * addressed by more than 24 DELETE routes, and those routes were filed UNPROBEABLE with
 * "the source tenant has no remaining object of this type" — which reads as a seed gap and was
 * a pool-size constant. 311 of the object-addressable routes are DELETEs; 200 covers the
 * busiest table with room to spare and costs one extra `LIMIT` per table on a read that already
 * runs once per sweep.
 */
export const DEFAULT_IDS_PER_TABLE = 200;

export async function loadCatalog(
  sql: ReturnType<typeof postgres>,
  orgId: string,
  perTable = DEFAULT_IDS_PER_TABLE,
  batchSize = 60,
): Promise<Catalog> {
  const rows = await sql.unsafe<{ schema: string; name: string; pk: string; org_column: string }[]>(
    ORG_SCOPED_TABLES,
  );
  const tables = new Map<string, TableRef>();
  for (const row of rows)
    tables.set(`${row.schema}.${row.name}`, {
      schema: row.schema,
      name: row.name,
      pk: row.pk,
      orgColumn: row.org_column,
    });

  const ids = new Map<string, readonly string[]>();
  const populated = new Set<string>();
  const all = [...tables.values()];
  for (let i = 0; i < all.length; i += batchSize) {
    const batch = all.slice(i, i + batchSize);
    const union = batch
      .map(
        (t) =>
          `SELECT '${t.schema}.${t.name}' AS t, (
             SELECT array_agg(v::text) FROM (
               SELECT "${t.pk}" AS v FROM ${quoted(t)}
               WHERE "${t.orgColumn}" = $1 ORDER BY "${t.pk}" LIMIT ${String(perTable)}
             ) z
           ) AS vals`,
      )
      .join(" UNION ALL ");
    const result = await sql.unsafe<{ t: string; vals: string[] | null }[]>(union, [orgId]);
    for (const row of result) {
      const values = row.vals ?? [];
      if (values.length === 0) continue;
      ids.set(row.t, values);
      populated.add(row.t);
    }
  }
  return { tables, populated, ids };
}
