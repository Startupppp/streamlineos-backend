SET statement_timeout = 0;

-- delivery_status was created in the baseline migration but never attached to any column,
-- and its Drizzle declaration has been removed. Drop the orphaned type.
-- Guarded: refuses to drop if any column anywhere still uses it.
DO $$
DECLARE
  in_use integer;
BEGIN
  SELECT count(*) INTO in_use
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_type t ON t.oid = a.atttypid
  WHERE t.typname = 'delivery_status'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF in_use > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop type delivery_status: % column(s) still use it.', in_use;
  END IF;
END $$;
--> statement-breakpoint

DROP TYPE IF EXISTS "delivery_status";
