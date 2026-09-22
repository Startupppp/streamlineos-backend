DO $guard$
DECLARE
  total integer;
BEGIN
  SELECT count(*) INTO total
    FROM pg_constraint
   WHERE contype = 'f' AND confdeltype = 'n';

  IF total < 100 THEN
    RAISE EXCEPTION
      'PREREQUISITE UNMET: the catalog reports % ON DELETE SET NULL foreign keys (floor 100). This database is empty or not bootstrapped to journal head; an empty result set is not a clean result set.',
      total;
  END IF;

  IF current_setting('server_version_num')::integer < 150000 THEN
    RAISE EXCEPTION
      'PREREQUISITE UNMET: server_version_num is %, below 150000. pg_constraint.confdelsetcols does not exist before PostgreSQL 15.',
      current_setting('server_version_num');
  END IF;
END
$guard$;

WITH fk AS (
    SELECT con.oid                       AS conoid,
           nsp.nspname                   AS child_schema,
           rel.relname                   AS child_table,
           con.conname                   AS constraint_name,
           fnsp.nspname                  AS parent_schema,
           frel.relname                  AS parent_table,
           con.conrelid                  AS conrelid,
           con.conkey                    AS conkey,
           con.confdelsetcols            AS confdelsetcols,
           pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class     rel  ON rel.oid  = con.conrelid
      JOIN pg_namespace nsp  ON nsp.oid  = rel.relnamespace
      JOIN pg_class     frel ON frel.oid = con.confrelid
      JOIN pg_namespace fnsp ON fnsp.oid = frel.relnamespace
     WHERE con.contype     = 'f'
       AND con.confdeltype = 'n'
),
members AS (
    SELECT fk.conoid,
           k.ord           AS ord,
           att.attname     AS attname,
           att.attnotnull  AS attnotnull
      FROM fk
     CROSS JOIN LATERAL unnest(fk.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute att
        ON att.attrelid = fk.conrelid
       AND att.attnum   = k.attnum
),
key_shape AS (
    SELECT conoid,
           count(*)::integer                    AS arity,
           array_agg(attname ORDER BY ord)      AS key_columns,
           array_agg(attname ORDER BY attname)  AS key_columns_sorted,
           coalesce(
             array_agg(attname ORDER BY attname) FILTER (WHERE NOT attnotnull),
             '{}'::name[]
           )                                    AS intended_set_null_columns,
           coalesce(
             array_agg(attname ORDER BY attname) FILTER (WHERE attnotnull),
             '{}'::name[]
           )                                    AS not_null_members
      FROM members
     GROUP BY conoid
),
declared AS (
    SELECT fk.conoid,
           array_agg(att.attname ORDER BY att.attname) AS confdelsetcols_columns
      FROM fk
     CROSS JOIN LATERAL unnest(fk.confdelsetcols) AS s(attnum)
      JOIN pg_attribute att
        ON att.attrelid = fk.conrelid
       AND att.attnum   = s.attnum
     GROUP BY fk.conoid
),
tenant AS (
    SELECT conoid,
           (array_agg(attname ORDER BY ord)
              FILTER (WHERE attname IN ('org_id', 'organization_id')))[1] AS tenant_column,
           coalesce(
             bool_or(attname IN ('org_id', 'organization_id') AND attnotnull),
             false
           )                                                              AS tenant_is_not_null
      FROM members
     GROUP BY conoid
),
graded AS (
    SELECT fk.child_schema,
           fk.child_table,
           fk.constraint_name,
           fk.parent_schema,
           fk.parent_table,
           ks.arity,
           ks.key_columns,
           ks.not_null_members,
           ks.intended_set_null_columns,
           d.confdelsetcols_columns,
           coalesce(d.confdelsetcols_columns, ks.key_columns_sorted) AS effective_set_null_columns,
           t.tenant_column,
           t.tenant_is_not_null,
           fk.definition,
           (
                 coalesce(d.confdelsetcols_columns, ks.key_columns_sorted) <@ ks.intended_set_null_columns
             AND ks.intended_set_null_columns <@ coalesce(d.confdelsetcols_columns, ks.key_columns_sorted)
           ) AS check_a_list_is_exactly_intended,
           (
             coalesce(d.confdelsetcols_columns, ks.key_columns_sorted) <@ ks.intended_set_null_columns
           ) AS check_b_every_named_column_nullable,
           (
             CASE
               WHEN t.tenant_column IS NULL THEN true
               ELSE t.tenant_is_not_null
                    AND NOT (t.tenant_column = ANY (coalesce(d.confdelsetcols_columns, ks.key_columns_sorted)))
             END
           ) AS check_c_tenant_excluded_and_not_null
      FROM fk
      JOIN key_shape ks ON ks.conoid = fk.conoid
      JOIN tenant    t  ON t.conoid  = fk.conoid
      LEFT JOIN declared d ON d.conoid = fk.conoid
)
SELECT child_schema,
       child_table,
       constraint_name,
       parent_schema,
       parent_table,
       arity,
       key_columns,
       not_null_members,
       intended_set_null_columns,
       confdelsetcols_columns,
       effective_set_null_columns,
       tenant_column,
       check_a_list_is_exactly_intended,
       check_b_every_named_column_nullable,
       check_c_tenant_excluded_and_not_null,
       CASE
         WHEN check_a_list_is_exactly_intended
          AND check_b_every_named_column_nullable
          AND check_c_tenant_excluded_and_not_null
         THEN 'PASS'
         ELSE 'FAIL'
       END AS verdict,
       CASE
         WHEN NOT check_b_every_named_column_nullable AND confdelsetcols_columns IS NULL
           THEN 'bare ON DELETE SET NULL over a key with a NOT NULL member: the parent DELETE raises 23502'
         WHEN NOT check_b_every_named_column_nullable
           THEN 'the column list names a NOT NULL column: the parent DELETE raises 23502'
         WHEN NOT check_c_tenant_excluded_and_not_null AND tenant_is_not_null IS false
           THEN 'the tenant column is nullable, so tenant isolation no longer rests on NOT NULL'
         WHEN NOT check_c_tenant_excluded_and_not_null
           THEN 'the tenant column is named in the set-null column list'
         WHEN NOT check_a_list_is_exactly_intended
           THEN 'the column list is not exactly the nullable member set: a parent DELETE nulls the wrong column or leaves a dangling pointer'
         ELSE NULL
       END AS failure_reason,
       definition
  FROM graded
 ORDER BY (CASE WHEN check_a_list_is_exactly_intended
                 AND check_b_every_named_column_nullable
                 AND check_c_tenant_excluded_and_not_null THEN 1 ELSE 0 END),
          child_schema,
          child_table,
          constraint_name;
