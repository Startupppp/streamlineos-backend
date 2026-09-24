-- 1127 — Recruitment: assessments and voice screens are evaluations
--
-- An assessment and a voice screen both produce a score for a candidate against
-- a job, from a named evaluator, at a point in time — which is what `interviews`
-- already stores. Two `interview_type` values reuse it rather than adding two
-- tables to a schema whose table count is frozen, and they inherit the panel,
-- scorecard and pipeline plumbing for free.
--
-- `external_ref` is the vendor's own invitation or call id, so a score webhook
-- can find the row it belongs to without the vendor echoing candidate details
-- back at us.
SET lock_timeout = '5s';
--> statement-breakpoint
-- ADD VALUE cannot run inside a transaction block before PG12; on 12+ it can,
-- but it still cannot be used in the same transaction that then writes the new
-- value. Nothing here writes one, so this is safe in the migration wrapper.
ALTER TYPE "interview_type" ADD VALUE IF NOT EXISTS 'ASSESSMENT';
--> statement-breakpoint
ALTER TYPE "interview_type" ADD VALUE IF NOT EXISTS 'VOICE_SCREEN';
--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "external_ref" text;
--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "external_platform" text;
--> statement-breakpoint
-- Unique per organisation, not globally: two vendors can and do mint the same
-- invitation id, and a global unique would let one tenant's assessment block
-- another tenant's.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_interviews_org_external_ref"
  ON "interviews" ("org_id", "external_platform", "external_ref")
  WHERE "external_ref" IS NOT NULL;
