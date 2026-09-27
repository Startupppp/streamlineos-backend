SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_sessions' AND column_name = 'mfa_satisfied_at'
  ) THEN
    RAISE EXCEPTION '1366-rollback precondition: user_sessions.mfa_satisfied_at is already absent';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE user_sessions DROP COLUMN mfa_satisfied_at;
