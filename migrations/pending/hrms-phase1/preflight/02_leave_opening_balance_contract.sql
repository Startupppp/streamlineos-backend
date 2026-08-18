-- The allowlisted backfill runner must verify the signed approval manifest,
-- set the three app.hrms_leave_opening_* GUCs below, and load this session's
-- pg_temp.hrms_leave_opening_registry before executing this read-only gate.
-- This file validates that assertion; it is not a signature verifier.
--
-- Required temporary registry columns:
--   source_balance_id integer, organization_id text, source_user_id text,
--   source_year integer, source_balance numeric, worker_id text,
--   worker_engagement_id text, leave_type_id integer, period_key text,
--   effective_date date. Every registry column is NOT NULL.

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '2min';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = public, pg_catalog;

DO $preflight$
DECLARE
  manifest_hash text := nullif(btrim(current_setting(
    'app.hrms_leave_opening_manifest_hash',
    true
  )), '');
  approval_reference text := nullif(btrim(current_setting(
    'app.hrms_leave_opening_approval_reference',
    true
  )), '');
  signature_verified text := current_setting(
    'app.hrms_leave_opening_signature_verified',
    true
  );
  registry_oid regclass := to_regclass('pg_temp.hrms_leave_opening_registry');
  source_rows bigint;
  source_total numeric;
BEGIN
  IF manifest_hash IS NULL OR manifest_hash !~ '^[0-9A-Fa-f]{64}$' THEN
    RAISE EXCEPTION 'HRMS_LEAVE_OPENING_MANIFEST_HASH_REQUIRED'
      USING ERRCODE = '22023';
  END IF;
  IF approval_reference IS NULL
    OR approval_reference !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$' THEN
    RAISE EXCEPTION 'HRMS_LEAVE_OPENING_APPROVAL_REFERENCE_REQUIRED'
      USING ERRCODE = '22023';
  END IF;
  IF signature_verified IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'HRMS_LEAVE_OPENING_SIGNATURE_VERIFICATION_REQUIRED'
      USING ERRCODE = '42501';
  END IF;
  IF registry_oid IS NULL THEN
    RAISE EXCEPTION 'HRMS_LEAVE_OPENING_DATE_REGISTRY_REQUIRED'
      USING ERRCODE = '42P01';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class relation
    WHERE relation.oid = registry_oid
      AND relation.relkind = 'r'
      AND relation.relpersistence = 't'
  ) THEN
    RAISE EXCEPTION 'HRMS_LEAVE_OPENING_DATE_REGISTRY_MUST_BE_TEMP_TABLE'
      USING ERRCODE = '42809';
  END IF;

  IF EXISTS (
    WITH expected(column_name, data_type, not_null) AS (
      VALUES
        ('source_balance_id', 'integer', true),
        ('organization_id', 'text', true),
        ('source_user_id', 'text', true),
        ('source_year', 'integer', true),
        ('source_balance', 'numeric', true),
        ('worker_id', 'text', true),
        ('worker_engagement_id', 'text', true),
        ('leave_type_id', 'integer', true),
        ('period_key', 'text', true),
        ('effective_date', 'date', true)
    ), actual AS (
      SELECT
        attribute.attname AS column_name,
        format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
        attribute.attnotnull AS not_null
      FROM pg_attribute attribute
      WHERE attribute.attrelid = registry_oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
    SELECT 1
    FROM expected
    FULL JOIN actual USING (column_name, data_type, not_null)
    WHERE expected.column_name IS NULL OR actual.column_name IS NULL
  ) THEN
    RAISE EXCEPTION 'HRMS_LEAVE_OPENING_DATE_REGISTRY_SHAPE_INVALID'
      USING ERRCODE = '42804';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.hrms_leave_opening_registry registry
    GROUP BY registry.source_balance_id
    HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'HRMS_LEAVE_OPENING_DATE_REGISTRY_DUPLICATE_SOURCE'
      USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM leave_balances source
    FULL JOIN pg_temp.hrms_leave_opening_registry registry
      ON registry.source_balance_id = source.id
    WHERE source.id IS NULL
       OR registry.source_balance_id IS NULL
       OR registry.organization_id IS DISTINCT FROM source.org_id
       OR registry.source_user_id IS DISTINCT FROM source.user_id
       OR registry.source_year IS DISTINCT FROM source.year
       OR registry.source_balance IS DISTINCT FROM source.balance
       OR registry.leave_type_id IS DISTINCT FROM source.leave_type_id
       OR registry.source_balance <= 0
       OR registry.source_balance > 1000000::numeric
       OR registry.worker_id IS NULL
       OR registry.worker_engagement_id IS NULL
       OR registry.period_key IS NULL
       OR btrim(registry.period_key) = ''
       OR registry.effective_date IS NULL
  ) THEN
    RAISE EXCEPTION 'HRMS_LEAVE_OPENING_DATE_REGISTRY_SOURCE_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.hrms_leave_opening_registry registry
    LEFT JOIN workers worker
      ON worker.organization_id = registry.organization_id
     AND worker.worker_id = registry.worker_id
    LEFT JOIN organization_people person
      ON person.organization_id = worker.organization_id
     AND person.organization_person_id = worker.organization_person_id
     AND person.user_id = registry.source_user_id
    LEFT JOIN worker_engagements engagement
      ON engagement.organization_id = registry.organization_id
     AND engagement.worker_id = registry.worker_id
     AND engagement.worker_engagement_id = registry.worker_engagement_id
    LEFT JOIN leave_types leave_type
      ON leave_type.org_id = registry.organization_id
     AND leave_type.id = registry.leave_type_id
    WHERE worker.worker_id IS NULL
       OR person.organization_person_id IS NULL
       OR engagement.worker_engagement_id IS NULL
       OR leave_type.id IS NULL
  ) THEN
    RAISE EXCEPTION 'HRMS_LEAVE_OPENING_CANONICAL_MAPPING_MISMATCH'
      USING ERRCODE = '23503';
  END IF;

  SELECT count(*), coalesce(sum(balance), 0)
  INTO source_rows, source_total
  FROM leave_balances;
  IF source_rows <> 5 OR source_total <> 94.20::numeric THEN
    RAISE EXCEPTION
      'HRMS_LEAVE_OPENING_APPROVED_BASELINE_DRIFT: rows %, total %',
      source_rows,
      source_total
      USING ERRCODE = '23514';
  END IF;
END
$preflight$;

SELECT
  registry.organization_id,
  registry.source_balance_id,
  registry.source_user_id,
  registry.source_year,
  registry.source_balance,
  registry.worker_id,
  registry.worker_engagement_id,
  registry.leave_type_id,
  registry.period_key,
  registry.effective_date,
  to_char(registry.effective_date, 'YYYY-MM') AS required_partition_month,
  'HRMS_LEAVE_OPENING_BALANCE'::text AS command_scope,
  lower(btrim(current_setting('app.hrms_leave_opening_manifest_hash')))
    || ':' || registry.source_balance_id::text AS command_id,
  0::integer AS effect_ordinal,
  'LEGACY_LEAVE_BALANCE'::text AS source_type,
  registry.source_balance_id::text AS source_id,
  0::integer AS source_ordinal,
  btrim(current_setting(
    'app.hrms_leave_opening_approval_reference'
  )) AS migration_batch_id
FROM pg_temp.hrms_leave_opening_registry registry
ORDER BY registry.organization_id, registry.source_balance_id;

ROLLBACK;
