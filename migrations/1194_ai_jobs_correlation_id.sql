SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.ai_jobs') IS NULL THEN
    RAISE EXCEPTION '1194 precondition: public.ai_jobs is absent';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "public"."ai_jobs" ADD COLUMN IF NOT EXISTS "correlation_id" varchar(128);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_ai_jobs_correlation_id"
  ON "public"."ai_jobs" ("correlation_id")
  WHERE "correlation_id" IS NOT NULL;
