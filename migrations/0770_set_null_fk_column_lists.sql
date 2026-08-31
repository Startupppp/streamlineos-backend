SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  r record;
  nullable_cols text;
  new_def text;
  fixed integer := 0;
  remaining integer;
BEGIN
  FOR r IN
    SELECT nsp.nspname AS sch,
           rel.relname AS tbl,
           con.conname AS name,
           pg_get_constraintdef(con.oid) AS def,
           con.oid AS conoid,
           con.conrelid AS relid,
           con.conkey AS keycols
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE con.contype = 'f'
      AND con.confdeltype = 'n'
      AND array_length(con.conkey, 1) > 1
      AND (con.confdelsetcols IS NULL OR array_length(con.confdelsetcols, 1) IS NULL)
      AND EXISTS (
        SELECT 1 FROM unnest(con.conkey) z(attnum)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = z.attnum
        WHERE a.attnotnull
      )
    ORDER BY nsp.nspname, rel.relname, con.conname
  LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY x.ord)
      INTO nullable_cols
      FROM unnest(r.keycols) WITH ORDINALITY x(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = r.relid AND a.attnum = x.attnum
     WHERE NOT a.attnotnull;

    IF nullable_cols IS NULL THEN
      RAISE EXCEPTION
        '0770: %.% constraint % has no nullable column — SET NULL is impossible, its delete action must change',
        r.sch, r.tbl, r.name;
    END IF;

    IF position('ON DELETE SET NULL' in r.def) = 0 THEN
      RAISE EXCEPTION '0770: unexpected definition for %.% constraint %: %', r.sch, r.tbl, r.name, r.def;
    END IF;

    new_def := replace(r.def, 'ON DELETE SET NULL', 'ON DELETE SET NULL (' || nullable_cols || ')');

    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', r.sch, r.tbl, r.name);
    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s NOT VALID', r.sch, r.tbl, r.name, new_def);
    EXECUTE format('ALTER TABLE %I.%I VALIDATE CONSTRAINT %I', r.sch, r.tbl, r.name);
    fixed := fixed + 1;
  END LOOP;

  SELECT count(*) INTO remaining
  FROM pg_constraint con
  WHERE con.contype = 'f'
    AND con.confdeltype = 'n'
    AND array_length(con.conkey, 1) > 1
    AND (con.confdelsetcols IS NULL OR array_length(con.confdelsetcols, 1) IS NULL)
    AND EXISTS (
      SELECT 1 FROM unnest(con.conkey) z(attnum)
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = z.attnum
      WHERE a.attnotnull
    );

  IF remaining > 0 THEN
    RAISE EXCEPTION '0770: % composite SET NULL foreign keys still carry no column list', remaining;
  END IF;

  RAISE NOTICE '0770: rebuilt % composite SET NULL foreign keys with an explicit column list', fixed;
END $$;
