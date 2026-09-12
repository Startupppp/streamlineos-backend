SET lock_timeout = '5s';
--> statement-breakpoint
-- Once 0622 has run, custom_field_definitions carries its (org_id, id) candidate key twice: as the
-- plain unique index uniq_cfd_org_id (0352) and as the constraint uniq_custom_field_definitions_org_id
-- (0622, which restores the key the cold-build route loses). A foreign key binds to whichever
-- identical key the catalogue lists first, and on the merged chain main's AR-02 composite foreign
-- keys (0947, 0952, 0967) bind to 0622's. main's 1003_s08_residual_duplicate_keys then drops 0622's
-- twin on the premise that nothing depends on it, and refuses.
--
-- Retire the twin here, before those foreign keys exist, so they bind to uniq_cfd_org_id, the key
-- production keeps; if that index is missing it is created first, so the table never loses its
-- candidate key. A foreign key already on the twin is re-added with its definition unchanged.
-- 1003's DROP ... IF EXISTS then finds nothing, and where the twin is already gone (every database
-- that ran 1003) this does nothing.
DO $twin$
DECLARE
  tw record;
  fk record;
  tbls text[] := '{}';
  names text[] := '{}';
  defs text[] := '{}';
  i int;
BEGIN
  SELECT u.conrelid, u.conname, u.conindid INTO tw
    FROM pg_constraint u
   WHERE u.conrelid = to_regclass('public.custom_field_definitions')
     AND u.conname = 'uniq_custom_field_definitions_org_id' AND u.contype = 'u';
  IF NOT FOUND THEN RETURN; END IF;
  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_cfd_org_id" ON custom_field_definitions (org_id, id);
  FOR fk IN
    SELECT f.conrelid::regclass::text AS tbl, f.conname, pg_get_constraintdef(f.oid) AS def
      FROM pg_constraint f
     WHERE f.contype = 'f' AND f.conindid = tw.conindid AND f.conparentid = 0
     ORDER BY f.conname
  LOOP
    tbls := tbls || fk.tbl; names := names || fk.conname::text; defs := defs || fk.def;
  END LOOP;
  FOR i IN 1 .. coalesce(cardinality(names), 0) LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', tbls[i], names[i]);
  END LOOP;
  ALTER TABLE custom_field_definitions DROP CONSTRAINT uniq_custom_field_definitions_org_id;
  FOR i IN 1 .. coalesce(cardinality(names), 0) LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', tbls[i], names[i], defs[i]);
  END LOOP;
END $twin$;
