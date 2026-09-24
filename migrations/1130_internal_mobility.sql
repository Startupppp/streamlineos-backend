-- 1130 — Internal mobility: the job's grade, and the current manager's approval
--
-- Two things an internal application needs that an external one does not.
--
-- `job_postings.job_level_id` gives the opening a grade. Without it a "grade
-- rule" has nothing to compare against, and the product would either enforce
-- nothing or invent a level from the salary band — which is the same number
-- read twice and means an org that pays above band cannot post at band.
-- Nullable on purpose: most openings will never carry a level, and a job
-- without one is exempt from the rule rather than refused by it.
--
-- The `internal_manager_*` columns sit on `candidate_applications` rather than
-- in a table of their own. HR's table count is frozen, and an approval that
-- belongs to exactly one application is a fact about that row: a separate
-- table would buy history nobody asked for and a join on every read.
--
-- `internal_manager_decision` is NULL for every external application, which is
-- how "this is an internal move" is read off the row — a boolean would have to
-- be backfilled and could then disagree with the decision beside it.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "job_postings" ADD COLUMN "job_level_id" integer;
--> statement-breakpoint
-- Composite, tenant-first, and NOT VALID then VALIDATE: ADD CONSTRAINT …
-- FOREIGN KEY takes ACCESS EXCLUSIVE on both tables while it installs the
-- triggers, and `job_postings` is read by the public careers site.
ALTER TABLE "job_postings" ADD CONSTRAINT "fk_job_postings_job_level_id_org"
  FOREIGN KEY ("org_id", "job_level_id") REFERENCES "public"."hr_job_levels"("org_id", "id")
  ON DELETE SET NULL ("job_level_id") NOT VALID;
--> statement-breakpoint
-- The column list on SET NULL is load-bearing. A bare `ON DELETE SET NULL` on
-- a composite key nulls `org_id` too, which violates its own NOT NULL and
-- aborts the parent delete instead of clearing the reference.
ALTER TABLE "job_postings" VALIDATE CONSTRAINT "fk_job_postings_job_level_id_org";
--> statement-breakpoint
ALTER TABLE "candidate_applications" ADD COLUMN "internal_manager_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "candidate_applications" ADD COLUMN "internal_manager_decision" text;
--> statement-breakpoint
ALTER TABLE "candidate_applications" ADD COLUMN "internal_manager_decided_at" timestamp;
--> statement-breakpoint
ALTER TABLE "candidate_applications" ADD COLUMN "internal_manager_note" text;
--> statement-breakpoint
-- When the manager was told, not when they were recorded. The application is
-- confidential until it reaches interview, so this stays NULL through screening
-- and a non-NULL value is the evidence that the notice went out exactly once.
ALTER TABLE "candidate_applications" ADD COLUMN "internal_manager_notified_at" timestamp;
--> statement-breakpoint
ALTER TABLE "candidate_applications" ADD CONSTRAINT "chk_candidate_applications_internal_decision"
  CHECK ("internal_manager_decision" IS NULL
    OR "internal_manager_decision" IN ('PENDING','APPROVED','DECLINED','NOT_REQUIRED')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "candidate_applications" ADD CONSTRAINT "fk_candidate_applications_internal_manager"
  FOREIGN KEY ("org_id", "internal_manager_membership_id")
  REFERENCES "public"."organization_members"("org_id", "id")
  ON DELETE SET NULL ("internal_manager_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "candidate_applications" VALIDATE CONSTRAINT "fk_candidate_applications_internal_manager";
--> statement-breakpoint
-- Partial: the manager's queue asks for one org's outstanding decisions, and
-- every external application in the table has a NULL here. Leading with
-- `org_id` because the table is tenant-scoped and every read of it is.
CREATE INDEX IF NOT EXISTS "idx_candidate_applications_internal_manager"
  ON "candidate_applications" ("org_id", "internal_manager_membership_id", "internal_manager_decision")
  WHERE "internal_manager_decision" IS NOT NULL;
