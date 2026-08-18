import type postgres from "postgres";
import { z } from "zod";
import { fail } from "./bundle-error";
import type { RootMigrationSnapshot } from "./bundle-files";
import type { BundleManifest } from "./bundle-manifest-schema";

const identityRowsSchema = z.array(
  z.object({
    database_name: z.string(),
    database_role: z.string(),
    configured_environment: z.string().nullable(),
    server_version_num: z.number(),
  }),
);

const roleRowsSchema = z.array(
  z.object({
    role_name: z.string(),
    is_superuser: z.boolean(),
    bypasses_rls: z.boolean(),
  }),
);

const journalColumnRowsSchema = z.array(
  z.object({
    column_name: z.string(),
    data_type: z.string(),
    not_null: z.boolean(),
    default_expression: z.string().nullable(),
  }),
);

const primaryKeyRowsSchema = z.array(
  z.object({ column_names: z.array(z.string()) }),
);

const journalRowsSchema = z.array(
  z.object({
    hash: z.string(),
    created_at: z.string(),
    latest_created_at: z.string().nullable(),
    missing_created_at_count: z.number(),
  }),
);

export type DatabaseIdentity = {
  database: string;
  databaseRole: string;
  environment: string;
  serverVersion: number;
};

export async function readAndVerifyDatabaseIdentity(
  client: postgres.Sql,
  manifest: BundleManifest,
): Promise<DatabaseIdentity> {
  const rawIdentity: unknown = await client`
    SELECT current_database() AS database_name,
      current_user AS database_role,
      NULLIF(current_setting('app.environment', true), '')
        AS configured_environment,
      current_setting('server_version_num')::integer AS server_version_num
  `;
  const rows = identityRowsSchema.parse(rawIdentity);
  const row = rows[0];
  if (!row || rows.length !== 1) fail("RUNNER_DATABASE_IDENTITY_INVALID");
  if (
    row.database_name !== manifest.database ||
    row.database_role !== manifest.databaseRole ||
    row.configured_environment !== manifest.environment ||
    row.server_version_num < manifest.serverVersion.min ||
    row.server_version_num > manifest.serverVersion.max
  )
    fail("RUNNER_DATABASE_IDENTITY_MISMATCH");

  const requestedRoles = [manifest.applicationRole, manifest.migrationRole];
  const rawRoles: unknown = await client`
    SELECT rolname AS role_name, rolsuper AS is_superuser,
      rolbypassrls AS bypasses_rls
    FROM pg_roles
    WHERE rolname = ANY(${requestedRoles}::name[])
    ORDER BY rolname
  `;
  const roles = roleRowsSchema.parse(rawRoles);
  if (roles.length !== 2) fail("RUNNER_MANIFEST_ROLE_MISSING");
  if (roles.some((role) => role.is_superuser || role.bypasses_rls))
    fail("RUNNER_MANIFEST_ROLE_UNSAFE");
  return {
    database: row.database_name,
    databaseRole: row.database_role,
    environment: row.configured_environment,
    serverVersion: row.server_version_num,
  };
}

function assertJournalColumns(
  rows: z.infer<typeof journalColumnRowsSchema>,
): void {
  const expected = [
    { name: "id", type: "integer", notNull: true },
    { name: "hash", type: "text", notNull: true },
    { name: "created_at", type: "bigint", notNull: false },
  ];
  if (rows.length !== expected.length)
    fail("RUNNER_DRIZZLE_JOURNAL_SHAPE_MISMATCH");
  for (const column of expected) {
    const actual = rows.find((row) => row.column_name === column.name);
    if (
      !actual ||
      actual.data_type !== column.type ||
      actual.not_null !== column.notNull
    )
      fail("RUNNER_DRIZZLE_JOURNAL_SHAPE_MISMATCH");
    if (column.name === "id" && !actual.default_expression?.startsWith("nextval("))
      fail("RUNNER_DRIZZLE_JOURNAL_SHAPE_MISMATCH");
    if (column.name !== "id" && actual.default_expression !== null)
      fail("RUNNER_DRIZZLE_JOURNAL_SHAPE_MISMATCH");
  }
}

export async function verifyRootMigration(
  client: postgres.Sql,
  root: RootMigrationSnapshot,
): Promise<void> {
  const rawColumns: unknown = await client`
    SELECT attribute.attname AS column_name,
      format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
      attribute.attnotnull AS not_null,
      pg_get_expr(default_value.adbin, default_value.adrelid)
        AS default_expression
    FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_attrdef default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE namespace.nspname = 'drizzle'
      AND relation.relname = '__drizzle_migrations'
      AND relation.relkind = 'r'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY attribute.attnum
  `;
  assertJournalColumns(journalColumnRowsSchema.parse(rawColumns));

  const rawPrimaryKey: unknown = await client`
    SELECT ARRAY(
      SELECT attribute.attname
      FROM unnest(catalog_constraint.conkey)
        WITH ORDINALITY key_column(attnum, key_position)
      JOIN pg_attribute attribute
        ON attribute.attrelid = catalog_constraint.conrelid
       AND attribute.attnum = key_column.attnum
      ORDER BY key_column.key_position
    ) AS column_names
    FROM pg_constraint catalog_constraint
    WHERE catalog_constraint.conrelid = 'drizzle.__drizzle_migrations'::regclass
      AND catalog_constraint.contype = 'p'
  `;
  const primaryKeys = primaryKeyRowsSchema.parse(rawPrimaryKey);
  if (
    primaryKeys.length !== 1 ||
    primaryKeys[0]?.column_names.length !== 1 ||
    primaryKeys[0]?.column_names[0] !== "id"
  )
    fail("RUNNER_DRIZZLE_JOURNAL_SHAPE_MISMATCH");

  const rawJournalRows: unknown = await client`
    SELECT hash, created_at::text AS created_at,
      (SELECT max(latest.created_at)::text
       FROM drizzle.__drizzle_migrations latest) AS latest_created_at,
      (SELECT count(*)::integer
       FROM drizzle.__drizzle_migrations incomplete
       WHERE incomplete.created_at IS NULL) AS missing_created_at_count
    FROM drizzle.__drizzle_migrations
    WHERE created_at = ${root.createdAt}
  `;
  const journalRows = journalRowsSchema.parse(rawJournalRows);
  if (
    journalRows.length !== 1 ||
    journalRows[0]?.created_at !== String(root.createdAt) ||
    journalRows[0]?.latest_created_at !== String(root.createdAt) ||
    journalRows[0]?.missing_created_at_count !== 0 ||
    journalRows[0]?.hash !== root.sha256
  )
    fail("RUNNER_ROOT_MIGRATION_NOT_APPLIED");
}
