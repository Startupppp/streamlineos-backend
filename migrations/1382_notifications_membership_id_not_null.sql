SET lock_timeout = '5s';
SET statement_timeout = 0;
--> statement-breakpoint

DO $$
DECLARE
  null_count bigint;
BEGIN
  IF to_regclass('public.notifications') IS NULL THEN
    RAISE EXCEPTION '1382 precondition: notifications is absent';
  END IF;
  SELECT count(*) INTO null_count FROM notifications WHERE membership_id IS NULL;
  IF null_count > 0 THEN
    RAISE EXCEPTION '1382 precondition: % row(s) with membership_id IS NULL; all must be resolved before applying NOT NULL', null_count;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_notifications_membership_id_not_null'
      AND conrelid = 'notifications'::regclass
  ) THEN
    ALTER TABLE notifications
      ADD CONSTRAINT chk_notifications_membership_id_not_null
      CHECK (membership_id IS NOT NULL) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE notifications VALIDATE CONSTRAINT chk_notifications_membership_id_not_null;
--> statement-breakpoint

ALTER TABLE notifications ALTER COLUMN membership_id SET NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_notifications_membership_id_not_null'
      AND conrelid = 'notifications'::regclass
  ) THEN
    ALTER TABLE notifications DROP CONSTRAINT chk_notifications_membership_id_not_null;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT (
    SELECT attnotnull
    FROM pg_attribute
    WHERE attrelid = 'notifications'::regclass
      AND attname = 'membership_id'
      AND attnum > 0
  ), '1382 post-check: membership_id is still nullable';
END $$;
