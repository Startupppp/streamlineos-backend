WITH fk AS (
    SELECT con.oid                       AS conoid,
           nsp.nspname                   AS child_schema,
           rel.relname                   AS child_table,
           con.conname                   AS constraint_name,
           fnsp.nspname                  AS parent_schema,
           frel.relname                  AS parent_table,
           con.conrelid                  AS conrelid,
           con.confrelid                 AS confrelid,
           con.conkey                    AS conkey,
           con.confkey                   AS confkey,
           pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class     rel  ON rel.oid  = con.conrelid
      JOIN pg_namespace nsp  ON nsp.oid  = rel.relnamespace
      JOIN pg_class     frel ON frel.oid = con.confrelid
      JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
     WHERE con.contype     = 'f'
       AND con.confdeltype = 'n'
),
pairs AS (
    SELECT fk.conoid,
           k.ord                AS ord,
           child_att.attname    AS child_column,
           child_att.attnotnull AS child_not_null,
           parent_att.attname   AS parent_column
      FROM fk
     CROSS JOIN LATERAL generate_subscripts(fk.conkey, 1) AS k(ord)
      JOIN pg_attribute child_att
        ON child_att.attrelid = fk.conrelid
       AND child_att.attnum   = fk.conkey[k.ord]
      JOIN pg_attribute parent_att
        ON parent_att.attrelid = fk.confrelid
       AND parent_att.attnum   = fk.confkey[k.ord]
),
shape AS (
    SELECT conoid,
           count(*)::integer AS arity,
           coalesce(
             bool_or(
               child_column IN ('org_id', 'organization_id')
               AND parent_column IN ('org_id', 'organization_id')
               AND child_not_null
             ),
             false
           ) AS tenant_paired,
           coalesce(
             bool_or(child_column IN ('org_id', 'organization_id')),
             false
           ) AS child_has_tenant_column,
           array_agg(child_column || ' -> ' || parent_column ORDER BY ord) AS column_mapping
      FROM pairs
     GROUP BY conoid
)
SELECT fk.child_schema,
       fk.child_table,
       fk.constraint_name,
       fk.parent_schema,
       fk.parent_table,
       shape.arity,
       shape.column_mapping,
       shape.child_has_tenant_column,
       shape.tenant_paired,
       CASE
         WHEN shape.tenant_paired THEN 'PASS'
         WHEN NOT shape.child_has_tenant_column THEN 'NOT_APPLICABLE'
         ELSE 'FAIL'
       END AS verdict,
       CASE
         WHEN shape.tenant_paired THEN NULL
         WHEN NOT shape.child_has_tenant_column
           THEN 'the child key carries no tenant column, so this constraint is not a tenant-composite key'
         ELSE 'the child tenant column is not matched against the parent tenant column, so a parent row in another tenant can satisfy this key'
       END AS finding,
       fk.definition
  FROM fk
  JOIN shape ON shape.conoid = fk.conoid
 ORDER BY (CASE WHEN shape.tenant_paired THEN 1 ELSE 0 END),
          fk.child_schema,
          fk.child_table,
          fk.constraint_name;
