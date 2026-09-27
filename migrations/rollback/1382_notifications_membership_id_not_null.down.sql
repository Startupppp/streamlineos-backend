SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'notifications'::regclass
      AND attname = 'membership_id'
      AND attnotnull = true
      AND attnum > 0
  ) THEN
    RAISE EXCEPTION '1382-rollback precondition: membership_id is already nullable — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE notifications ALTER COLUMN membership_id DROP NOT NULL;
