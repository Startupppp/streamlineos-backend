SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.project_webhooks') IS NULL THEN
    RAISE EXCEPTION '1421 precondition: build.project_webhooks is absent';
  END IF;
  IF to_regclass('build.okr_goals') IS NULL THEN
    RAISE EXCEPTION '1421 precondition: build.okr_goals is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'okr_goals' AND column_name = 'updated_at'
  ) THEN
    RAISE EXCEPTION '1421 precondition: build.okr_goals.updated_at is absent, so a goal edit could not record when it happened';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'build' AND p.proname = 'bump_sibling_version'
  ) THEN
    RAISE EXCEPTION '1421 precondition: build.bump_sibling_version() is absent — migration 1395 must be applied first, because reusing one bump function is what keeps every build aggregate on the same token semantics';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."project_webhooks" ADD COLUMN IF NOT EXISTS "secret_set_at" timestamptz;
--> statement-breakpoint

ALTER TABLE "build"."project_webhooks" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint

UPDATE "build"."project_webhooks" SET "updated_at" = "created_at" WHERE "updated_at" > "created_at";
--> statement-breakpoint

ALTER TABLE "build"."project_webhooks" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint

ALTER TABLE "build"."okr_goals" ADD COLUMN IF NOT EXISTS "confidence" integer;
--> statement-breakpoint

ALTER TABLE "build"."okr_goals" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint

ALTER TABLE "build"."okr_goals"
  ADD CONSTRAINT "chk_okr_goals_confidence_range"
  CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 100)) NOT VALID;
--> statement-breakpoint

ALTER TABLE "build"."okr_goals" VALIDATE CONSTRAINT "chk_okr_goals_confidence_range";
--> statement-breakpoint

CREATE TRIGGER trg_project_webhooks_version_bump
  BEFORE UPDATE ON "build"."project_webhooks"
  FOR EACH ROW
  EXECUTE FUNCTION build.bump_sibling_version();
--> statement-breakpoint

CREATE TRIGGER trg_okr_goals_version_bump
  BEFORE UPDATE ON "build"."okr_goals"
  FOR EACH ROW
  EXECUTE FUNCTION build.bump_sibling_version();
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'project_webhooks' AND column_name = 'secret_set_at'
  ), '1421 post-check: secret_set_at was not added to build.project_webhooks';

  ASSERT (
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'project_webhooks' AND column_name = 'secret_set_at'
  ) = 'YES', '1421 post-check: secret_set_at must stay nullable — a NOT NULL column would force a backfill that invents a secret age for rows whose secret age is unknown';

  ASSERT NOT EXISTS (
    SELECT 1 FROM "build"."project_webhooks" WHERE "secret_set_at" IS NOT NULL
  ), '1421 post-check: secret_set_at was backfilled, which manufactures a secret age that was never recorded';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'project_webhooks' AND column_name = 'updated_at'
  ), '1421 post-check: updated_at was not added to build.project_webhooks';

  ASSERT NOT EXISTS (
    SELECT 1 FROM "build"."project_webhooks" WHERE "updated_at" > "created_at"
  ), '1421 post-check: a pre-existing webhook claims it was updated after it was created, which is the migration timestamp leaking in as a false edit';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'project_webhooks' AND column_name = 'version'
  ), '1421 post-check: version was not added to build.project_webhooks';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'okr_goals' AND column_name = 'confidence'
  ), '1421 post-check: confidence was not added to build.okr_goals';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'okr_goals' AND column_name = 'version'
  ), '1421 post-check: version was not added to build.okr_goals';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'okr_goals' AND column_name IN ('target', 'current', 'target_value', 'current_value')
  ), '1421 post-check: a goal-level target or current column exists, which would be a second source of truth against okr_key_results';

  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_okr_goals_confidence_range' AND conrelid = 'build.okr_goals'::regclass AND convalidated
  ), '1421 post-check: chk_okr_goals_confidence_range is missing or unvalidated';

  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_project_webhooks_version_bump' AND tgrelid = 'build.project_webhooks'::regclass
  ), '1421 post-check: trg_project_webhooks_version_bump was not created, so a webhook edit would leave the token stale and every later edit would collide';

  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_okr_goals_version_bump' AND tgrelid = 'build.okr_goals'::regclass
  ), '1421 post-check: trg_okr_goals_version_bump was not created, so a goal edit would leave the token stale and every later edit would collide';
END $$;
