SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  r record;
  dropped integer := 0;
  remaining integer;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'notification_audit_logs'
      AND con.contype = 'f'
      AND con.conname <> (
        SELECT c2.conname
        FROM pg_constraint c2
        JOIN pg_class r2 ON r2.oid = c2.conrelid
        WHERE r2.relname = 'notification_audit_logs'
          AND c2.contype = 'f'
          AND c2.conkey = con.conkey
          AND c2.confrelid = con.confrelid
          AND c2.confkey = con.confkey
        ORDER BY c2.oid
        LIMIT 1
      )
  LOOP
    EXECUTE format('ALTER TABLE public.notification_audit_logs DROP CONSTRAINT %I', r.conname);
    dropped := dropped + 1;
  END LOOP;

  SELECT count(*) INTO remaining
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'notification_audit_logs' AND con.contype = 'f';

  IF EXISTS (
    SELECT 1
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'notification_audit_logs' AND con.contype = 'f'
    GROUP BY con.conkey, con.confrelid, con.confkey
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0773: duplicate foreign keys still present on notification_audit_logs';
  END IF;

  RAISE NOTICE '0773: dropped % duplicate foreign key(s); % remain', dropped, remaining;
END $$;
