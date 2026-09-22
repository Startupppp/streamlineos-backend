\set ON_ERROR_STOP on

\echo 'POSTCONDITION 1 - build.projects.pm_workspace_id is nullable'
SELECT
  n.nspname   AS schema,
  c.relname   AS table,
  a.attname   AS column,
  a.attnotnull AS still_not_null,
  CASE WHEN a.attnotnull THEN 'FAIL 1141 not in effect' ELSE 'PASS' END AS verdict
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'build' AND c.relname = 'projects' AND a.attname = 'pm_workspace_id';

\echo 'POSTCONDITION 2 - no leftover scaffolding constraint from the 1141 rollback path'
SELECT
  count(*) AS scaffolding_constraints,
  CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL rollback scaffolding left in place' END AS verdict
FROM pg_constraint
WHERE conname = 'chk_projects_pm_workspace_id_not_null';

\echo 'POSTCONDITION 3 - fk_job_requisitions_headcount_org nulls only headcount_id'
SELECT
  k.conname,
  k.convalidated,
  k.confdeltype,
  coalesce(string_agg(a.attname, ',' ORDER BY a.attname), '<none>') AS set_null_columns,
  CASE
    WHEN coalesce(string_agg(a.attname, ',' ORDER BY a.attname), '<none>') = 'headcount_id'
     AND k.convalidated
     AND k.confdeltype = 'n'
    THEN 'PASS'
    ELSE 'FAIL 1142 not in effect'
  END AS verdict
FROM pg_constraint k
LEFT JOIN LATERAL unnest(k.confdelsetcols) AS s(attnum) ON true
LEFT JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = s.attnum
WHERE k.conname = 'fk_job_requisitions_headcount_org'
GROUP BY k.conname, k.convalidated, k.confdeltype;

\echo 'POSTCONDITION 4 - both migrations are recorded in the drizzle ledger'
SELECT
  expected.tag,
  expected.when_ms,
  m.created_at,
  (m.hash IS NOT NULL) AS recorded,
  CASE
    WHEN m.hash IS NULL THEN 'FAIL ledger row missing'
    WHEN m.created_at IS DISTINCT FROM expected.when_ms THEN 'WARN created_at does not match the journal when'
    ELSE 'PASS'
  END AS verdict
FROM (VALUES
  ('1141_projects_pm_workspace_optional', 'a65318a8013ed2c733be1c6af0f8529fe43b7d09d7667e71a0e6ce0aa3951042', 1803000010410::bigint),
  ('1142_fix_requisition_headcount_fk_set_null', '96f76c745ff077deafac70f5e5960cefc38f2c136f709b8890a904ca07e26ba3', 1803000010420::bigint)
) AS expected(tag, sha256, when_ms)
LEFT JOIN drizzle.__drizzle_migrations m ON m.hash = expected.sha256;

\echo 'POSTCONDITION 5 - ledger depth, compare against the 903 files on disk'
SELECT count(*) AS applied_rows FROM drizzle.__drizzle_migrations;

\echo 'POSTCONDITION 6 - every composite SET NULL foreign key whose key has a NOT NULL member carries a column list'
SELECT
  cls.relname AS table,
  k.conname,
  array_length(k.conkey, 1) AS key_width,
  coalesce(array_length(k.confdelsetcols, 1), 0) AS set_null_cols,
  'FAIL bare SET NULL over a key containing a NOT NULL column' AS verdict
FROM pg_constraint k
JOIN pg_class cls ON cls.oid = k.conrelid
WHERE k.contype = 'f'
  AND k.confdeltype = 'n'
  AND k.confdelsetcols IS NULL
  AND array_length(k.conkey, 1) > 1
  AND EXISTS (
    SELECT 1 FROM unnest(k.conkey) AS ck(attnum)
    JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ck.attnum
    WHERE a.attnotnull
  )
ORDER BY cls.relname, k.conname;
