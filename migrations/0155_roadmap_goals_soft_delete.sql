-- Soft delete: roadmap_items, feedback_posts, okr_goals
--
-- Adds deleted_at (nullable timestamptz) to all three tables.
-- Delete paths now stamp deleted_at instead of issuing a physical DELETE.
-- Every read already filters WHERE deleted_at IS NULL in application code.
--
-- Hot indexes are replaced with partial variants (WHERE deleted_at IS NULL) so
-- list/board queries only scan live rows and the planner sees accurate stats.
--
-- Votes (roadmap_votes, feedback_votes) and key-results / check-ins are join/link
-- rows and are left as-is (§19 hard-delete exemption). They become unreachable
-- once their parent is soft-deleted because the application filters the parent out.
--
-- ADD COLUMN with no DEFAULT is a metadata-only operation on Postgres 11+
-- (NULL values are not written to existing rows, so no table rewrite occurs).

SET lock_timeout = '5s';

ALTER TABLE "roadmap_items" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_roadmap_items_org_status";
--> statement-breakpoint

CREATE INDEX "idx_roadmap_items_org_status" ON "roadmap_items" ("org_id", "status") WHERE deleted_at IS NULL;
--> statement-breakpoint

ALTER TABLE "feedback_posts" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_feedback_posts_org_status";
--> statement-breakpoint

CREATE INDEX "idx_feedback_posts_org_status" ON "feedback_posts" ("org_id", "status") WHERE deleted_at IS NULL;
--> statement-breakpoint

ALTER TABLE "okr_goals" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_okr_goals_org";
--> statement-breakpoint

CREATE INDEX "idx_okr_goals_org" ON "okr_goals" ("org_id") WHERE deleted_at IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_okr_goals_org_status";
--> statement-breakpoint

CREATE INDEX "idx_okr_goals_org_status" ON "okr_goals" ("org_id", "status") WHERE deleted_at IS NULL;
--> statement-breakpoint

ANALYZE roadmap_items;
--> statement-breakpoint

ANALYZE feedback_posts;
--> statement-breakpoint

ANALYZE okr_goals;
