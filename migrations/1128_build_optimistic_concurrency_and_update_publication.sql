-- Build optimistic concurrency, update publication, risk review, decision
-- supersession. Every `version` column is `NOT NULL DEFAULT 1`; a non-volatile
-- default is metadata-only from PostgreSQL 11 on, so none of these rewrites a
-- table and `lock_timeout` is the only fence needed.
--
-- `project_risks.category` is deliberately `text`, not an enum: the risk
-- taxonomy is org-defined and BLD-02F specifies it only as a filter facet.
--
-- `project_decisions.superseded_by_id` uses PostgreSQL 15's column-list
-- `SET NULL ("superseded_by_id")` because the composite tenant FK leads with a
-- NOT NULL `org_id`, which a bare SET NULL would try to null.
--
-- Not CONCURRENTLY: `db:migrate` runs each file in a transaction.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "build"."pm_workspaces" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "build"."project_updates" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "build"."test_suites" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "build"."test_cases" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "build"."test_runs" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "build"."test_run_results" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "build"."project_incidents" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "build"."project_risks" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "build"."project_decisions" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_update_audience') THEN
    CREATE TYPE "public"."project_update_audience" AS ENUM ('internal', 'client');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_update_status') THEN
    CREATE TYPE "public"."project_update_status" AS ENUM ('draft', 'published');
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "build"."project_updates"
  ADD COLUMN IF NOT EXISTS "audience" "public"."project_update_audience" NOT NULL DEFAULT 'internal';
--> statement-breakpoint
ALTER TABLE "build"."project_updates"
  ADD COLUMN IF NOT EXISTS "status" "public"."project_update_status" NOT NULL DEFAULT 'draft';
--> statement-breakpoint
ALTER TABLE "build"."project_updates" ADD COLUMN IF NOT EXISTS "published_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "build"."project_updates" DROP CONSTRAINT IF EXISTS "chk_project_updates_published_at";
--> statement-breakpoint
ALTER TABLE "build"."project_updates"
  ADD CONSTRAINT "chk_project_updates_published_at"
  CHECK (("status" = 'draft' AND "published_at" IS NULL) OR ("status" = 'published' AND "published_at" IS NOT NULL))
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_updates" VALIDATE CONSTRAINT "chk_project_updates_published_at";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_updates_org_project_audience_cursor"
  ON "build"."project_updates" (org_id, project_id, audience, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND status = 'published';
--> statement-breakpoint
ALTER TABLE "build"."project_risks" ADD COLUMN IF NOT EXISTS "review_date" timestamp;
--> statement-breakpoint
ALTER TABLE "build"."project_risks" ADD COLUMN IF NOT EXISTS "category" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_risks_org_project_review_date"
  ON "build"."project_risks" (org_id, project_id, review_date)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
ALTER TABLE "build"."project_decisions" ADD COLUMN IF NOT EXISTS "superseded_by_id" integer;
--> statement-breakpoint
ALTER TABLE "build"."project_decisions" DROP CONSTRAINT IF EXISTS "fk_project_decisions_org_superseded_by";
--> statement-breakpoint
ALTER TABLE "build"."project_decisions"
  ADD CONSTRAINT "fk_project_decisions_org_superseded_by"
  FOREIGN KEY ("org_id", "superseded_by_id")
  REFERENCES "build"."project_decisions" ("org_id", "id")
  ON DELETE SET NULL ("superseded_by_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_decisions" VALIDATE CONSTRAINT "fk_project_decisions_org_superseded_by";
--> statement-breakpoint
ALTER TABLE "build"."project_decisions" DROP CONSTRAINT IF EXISTS "chk_project_decisions_not_self_superseded";
--> statement-breakpoint
ALTER TABLE "build"."project_decisions"
  ADD CONSTRAINT "chk_project_decisions_not_self_superseded"
  CHECK ("superseded_by_id" IS NULL OR "superseded_by_id" <> "id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_decisions" VALIDATE CONSTRAINT "chk_project_decisions_not_self_superseded";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_decisions_org_superseded_by"
  ON "build"."project_decisions" (org_id, superseded_by_id)
  WHERE superseded_by_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_test_run_results_org_run_id"
  ON "build"."test_run_results" (org_id, run_id, id);
