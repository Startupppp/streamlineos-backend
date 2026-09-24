SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.ai_jobs') IS NULL THEN
    RAISE EXCEPTION '1175 precondition: public.ai_jobs is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.ai_jobs'::regclass
      AND attname = 'locked_at'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION '1175 precondition: public.ai_jobs.locked_at is absent — there is no lease to index';
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_ai_jobs_expired_lease"
  ON "public"."ai_jobs" ("locked_at")
  WHERE "status" = 'RUNNING';
