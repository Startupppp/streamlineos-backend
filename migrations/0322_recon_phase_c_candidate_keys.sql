-- wave-4-phase-c-candidate-keys.sql  (Wave 4 Phase C — tenant candidate keys)
-- Adds a UNIQUE (org_id, <pk>) CONSTRAINT to every public tenant parent table
-- that has a NOT-NULL org_id/organization_id column + a single-column primary key
-- and lacks such a constraint. These candidate keys are the FK targets that Phase D
-- composite (org_id, child_fk) -> parent(org_id, pk) foreign keys require (a plain
-- UNIQUE INDEX does not satisfy Postgres FK-target rules — a UNIQUE CONSTRAINT does).
--
-- Idempotent + drift-tolerant: skips tables already covered, and any table whose PK
-- column IS the org column (e.g. access_versions). Zero-risk to apply — (org_id, pk)
-- is trivially unique because pk is the primary key. Applied + verified on the Neon
-- dev branch (665/666 qualifying tables constrained).

DO $$
DECLARE
  r RECORD;
  cname text;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl, c.oid AS reloid,
           org.attname AS org_col, org.attnum AS org_num,
           pk.attname  AS pk_col,  pk.attnum  AS pk_num
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN LATERAL (
      SELECT a.attname, a.attnum
      FROM pg_attribute a
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname IN ('org_id','organization_id') AND a.attnotnull
      ORDER BY CASE a.attname WHEN 'org_id' THEN 0 ELSE 1 END
      LIMIT 1
    ) org ON true
    JOIN LATERAL (
      SELECT a.attname, a.attnum
      FROM pg_constraint pc
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = pc.conkey[1]
      WHERE pc.conrelid = c.oid AND pc.contype = 'p' AND array_length(pc.conkey,1) = 1
      LIMIT 1
    ) pk ON true
    WHERE c.relkind = 'r' AND org.attnum <> pk.attnum
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = r.reloid AND contype = 'u'
        AND array_length(conkey, 1) = 2
        AND conkey @> ARRAY[r.org_num, r.pk_num]::smallint[]
    ) THEN
      CONTINUE;
    END IF;
    cname := left('uniq_' || r.tbl || '_org_id', 63);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (%I, %I)',
      r.tbl, cname, r.org_col, r.pk_col
    );
  END LOOP;
END $$;
