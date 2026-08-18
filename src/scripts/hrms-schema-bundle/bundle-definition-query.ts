import type postgres from "postgres";
import { fail } from "./bundle-error";
import {
  columnRowsSchema,
  constraintRowsSchema,
  enumRowsSchema,
  functionRowsSchema,
  indexRowsSchema,
  type ColumnRow,
  type ConstraintRow,
  type EnumRow,
  type FunctionRow,
  type IndexRow,
} from "./bundle-definition-schema";

export function relationIdentity(relation: string): {
  schema: string;
  name: string;
} {
  const parts = relation.split(".");
  if (parts.length === 1 && parts[0])
    return { schema: "public", name: parts[0] };
  if (parts.length === 2 && parts[0] && parts[1])
    return { schema: parts[0], name: parts[1] };
  fail("RUNNER_CATALOG_RECIPE_INVALID");
}

export async function readColumnDefinition(
  tx: postgres.TransactionSql,
  relation: string,
  column: string,
): Promise<ColumnRow> {
  const identity = relationIdentity(relation);
  const rawRows: unknown = await tx`
    SELECT format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
      attribute.attnotnull AS not_null,
      pg_get_expr(default_value.adbin, default_value.adrelid, true)
        AS default_expression,
      attribute.attidentity::text AS identity
    FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_attrdef default_value
      ON default_value.adrelid = attribute.attrelid
      AND default_value.adnum = attribute.attnum
    WHERE namespace.nspname = ${identity.schema}
      AND relation.relname = ${identity.name}
      AND attribute.attname = ${column}
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  `;
  const rows = columnRowsSchema.parse(rawRows);
  if (rows.length !== 1) fail("RUNNER_CATALOG_COLUMN_MISMATCH");
  const row = rows[0];
  if (!row) fail("RUNNER_CATALOG_COLUMN_MISMATCH");
  return row;
}

export async function readConstraintDefinition(
  tx: postgres.TransactionSql,
  relation: string,
  constraint: string,
): Promise<ConstraintRow> {
  const identity = relationIdentity(relation);
  const rawRows: unknown = await tx`
    SELECT catalog_constraint.contype::text AS constraint_type,
      catalog_constraint.convalidated AS validated,
      catalog_constraint.condeferrable AS deferrable,
      catalog_constraint.condeferred AS initially_deferred,
      catalog_constraint.connoinherit AS no_inherit,
      catalog_constraint.conislocal AS is_local,
      catalog_constraint.coninhcount::integer AS inheritance_count,
      catalog_constraint.conparentid <> 0 AS has_parent_constraint,
      COALESCE(ARRAY(
        SELECT attribute.attname
        FROM unnest(catalog_constraint.conkey) WITH ORDINALITY
          key_column(attribute_number, ordinal)
        JOIN pg_attribute attribute
          ON attribute.attrelid = catalog_constraint.conrelid
          AND attribute.attnum = key_column.attribute_number
        ORDER BY key_column.ordinal
      ), ARRAY[]::text[]) AS columns,
      referenced_namespace.nspname AS referenced_schema,
      referenced_relation.relname AS referenced_relation,
      COALESCE(ARRAY(
        SELECT attribute.attname
        FROM unnest(catalog_constraint.confkey) WITH ORDINALITY
          key_column(attribute_number, ordinal)
        JOIN pg_attribute attribute
          ON attribute.attrelid = catalog_constraint.confrelid
          AND attribute.attnum = key_column.attribute_number
        ORDER BY key_column.ordinal
      ), ARRAY[]::text[]) AS referenced_columns,
      CASE WHEN catalog_constraint.contype = 'f'
        THEN catalog_constraint.confmatchtype::text END AS match_type,
      CASE WHEN catalog_constraint.contype = 'f'
        THEN catalog_constraint.confupdtype::text END AS update_action,
      CASE WHEN catalog_constraint.contype = 'f'
        THEN catalog_constraint.confdeltype::text END AS delete_action,
      COALESCE(backing_index.indnullsnotdistinct, false)
        AS nulls_not_distinct,
      backing_index.indisvalid AS backing_index_valid,
      backing_index.indisready AS backing_index_ready,
      backing_index.indislive AS backing_index_live,
      backing_access_method.amname AS backing_index_method,
      CASE WHEN catalog_constraint.contype = 'c'
        THEN pg_get_expr(
          catalog_constraint.conbin,
          catalog_constraint.conrelid,
          true
        ) END AS check_expression,
      pg_get_constraintdef(catalog_constraint.oid, true)
        AS constraint_definition
    FROM pg_constraint catalog_constraint
    JOIN pg_class relation ON relation.oid = catalog_constraint.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_class referenced_relation
      ON referenced_relation.oid = catalog_constraint.confrelid
    LEFT JOIN pg_namespace referenced_namespace
      ON referenced_namespace.oid = referenced_relation.relnamespace
    LEFT JOIN pg_index backing_index
      ON backing_index.indexrelid = catalog_constraint.conindid
    LEFT JOIN pg_class backing_index_relation
      ON backing_index_relation.oid = catalog_constraint.conindid
    LEFT JOIN pg_am backing_access_method
      ON backing_access_method.oid = backing_index_relation.relam
    WHERE namespace.nspname = ${identity.schema}
      AND relation.relname = ${identity.name}
      AND catalog_constraint.conname = ${constraint}
  `;
  const rows = constraintRowsSchema.parse(rawRows);
  if (rows.length !== 1) fail("RUNNER_CATALOG_CONSTRAINT_MISMATCH");
  const row = rows[0];
  if (!row) fail("RUNNER_CATALOG_CONSTRAINT_MISMATCH");
  return row;
}

export async function readIndexDefinition(
  tx: postgres.TransactionSql,
  indexSchema: string,
  indexName: string,
): Promise<IndexRow> {
  const rawRows: unknown = await tx`
    SELECT relation.relname AS relation_name,
      access_method.amname AS access_method,
      catalog_index.indisunique AS unique,
      catalog_index.indisprimary AS primary,
      catalog_index.indisvalid AS valid,
      catalog_index.indisready AS ready,
      catalog_index.indislive AS live,
      catalog_index.indnullsnotdistinct AS nulls_not_distinct,
      catalog_index.indnkeyatts::integer AS key_count,
      catalog_index.indnatts::integer AS attribute_count,
      ARRAY(
        SELECT pg_get_indexdef(index_relation.oid, ordinal, true)
        FROM generate_series(1, catalog_index.indnkeyatts) ordinal
        ORDER BY ordinal
      ) AS keys,
      pg_get_expr(catalog_index.indpred, catalog_index.indrelid, true)
        AS predicate
    FROM pg_class index_relation
    JOIN pg_namespace namespace
      ON namespace.oid = index_relation.relnamespace
    JOIN pg_index catalog_index
      ON catalog_index.indexrelid = index_relation.oid
    JOIN pg_class relation ON relation.oid = catalog_index.indrelid
    JOIN pg_am access_method ON access_method.oid = index_relation.relam
    WHERE index_relation.oid = to_regclass(
      format('%I.%I', ${indexSchema}, ${indexName})
    )
  `;
  const rows = indexRowsSchema.parse(rawRows);
  if (rows.length !== 1) fail("RUNNER_CATALOG_INDEX_MISMATCH");
  const row = rows[0];
  if (!row) fail("RUNNER_CATALOG_INDEX_MISMATCH");
  return row;
}

export async function readFunctionDefinitions(
  tx: postgres.TransactionSql,
  functionName: string,
  applicationRole: string,
  migrationRole: string,
): Promise<FunctionRow[]> {
  const rawRows: unknown = await tx`
    SELECT pg_get_userbyid(routine.proowner) AS owner_name,
      ARRAY(
        SELECT format_type(argument_type, NULL)
        FROM unnest(routine.proargtypes) WITH ORDINALITY
          argument(argument_type, ordinal)
        ORDER BY ordinal
      ) AS argument_types,
      format_type(routine.prorettype, NULL) AS result_type,
      language.lanname AS language_name,
      routine.prosecdef AS security_definer,
      routine.provolatile::text AS volatility,
      routine.proisstrict AS strict,
      routine.proleakproof AS leakproof,
      routine.proparallel::text AS parallel_safety,
      routine.prosrc AS source,
      COALESCE(routine.proconfig, ARRAY[]::text[]) AS configuration,
      ARRAY(
        SELECT format(
          '%s:EXECUTE%s',
          CASE WHEN access.grantee = 0
            THEN 'PUBLIC' ELSE pg_get_userbyid(access.grantee) END,
          CASE WHEN access.is_grantable THEN ':GRANT' ELSE '' END
        )
        FROM aclexplode(COALESCE(
          routine.proacl,
          acldefault('f', routine.proowner)
        )) access
        ORDER BY 1
      ) AS direct_grants,
      has_function_privilege(
        ${applicationRole}::name, routine.oid, 'EXECUTE'
      ) AS application_execute,
      has_function_privilege(
        ${migrationRole}::name, routine.oid, 'EXECUTE'
      ) AS migration_execute
    FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    JOIN pg_language language ON language.oid = routine.prolang
    WHERE namespace.nspname = 'app'
      AND routine.proname = ${functionName}
    ORDER BY routine.oid
  `;
  return functionRowsSchema.parse(rawRows);
}

export async function readEnumDefinition(
  tx: postgres.TransactionSql,
  enumName: string,
  applicationRole: string,
  migrationRole: string,
): Promise<EnumRow> {
  const rawRows: unknown = await tx`
    SELECT pg_get_userbyid(target.typowner) AS owner_name,
      ARRAY(
        SELECT label.enumlabel
        FROM pg_enum label
        WHERE label.enumtypid = target.oid
        ORDER BY label.enumsortorder
      ) AS labels,
      NOT EXISTS (
        (SELECT access.grantee, access.privilege_type, access.is_grantable
         FROM aclexplode(COALESCE(
           target.typacl,
           acldefault('T', target.typowner)
         )) access
         EXCEPT
         SELECT access.grantee, access.privilege_type, access.is_grantable
         FROM aclexplode(acldefault('T', target.typowner)) access)
        UNION ALL
        (SELECT access.grantee, access.privilege_type, access.is_grantable
         FROM aclexplode(acldefault('T', target.typowner)) access
         EXCEPT
         SELECT access.grantee, access.privilege_type, access.is_grantable
         FROM aclexplode(COALESCE(
           target.typacl,
           acldefault('T', target.typowner)
         )) access)
      ) AS acl_matches_default,
      has_type_privilege(${applicationRole}::name, target.oid, 'USAGE')
        AS application_usage,
      has_type_privilege(${migrationRole}::name, target.oid, 'USAGE')
        AS migration_usage
    FROM pg_type target
    JOIN pg_namespace namespace ON namespace.oid = target.typnamespace
    WHERE namespace.nspname = 'public'
      AND target.typname = ${enumName}
      AND target.typtype = 'e'
  `;
  const rows = enumRowsSchema.parse(rawRows);
  if (rows.length !== 1) fail("RUNNER_CATALOG_ENUM_MISMATCH");
  const row = rows[0];
  if (!row) fail("RUNNER_CATALOG_ENUM_MISMATCH");
  return row;
}
