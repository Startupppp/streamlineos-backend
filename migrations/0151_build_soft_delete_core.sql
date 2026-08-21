-- SCH-007: Soft delete for projects, sprints, ticket_comments
-- Cascade strategy (option a): deleteProject stamps deleted_at on tickets,
-- ticket_comments, and sprints in the same transaction, then on the project.
-- deleteSprint and deleteComment stamp their own row (replies cascade on comments).
-- Every list/read query gains WHERE deleted_at IS NULL.
--
-- Index changes:
--   projects:  uniq_projects_org_key -> partial (released on soft-delete so keys
--              can be reused); idx_projects_org_status + idx_projects_name_trgm
--              -> partial (live-rows only).
--   sprints:   idx_sprints_project_status -> partial.
--   ticket_comments: idx_ticket_comments_ticket -> partial.
--
-- Postgres 11+: ADD COLUMN with no default is metadata-only (no table rewrite).

SET lock_timeout = '5s';

ALTER TABLE "projects" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint

-- projects: drop old non-partial indexes before recreating as partial
DROP INDEX IF EXISTS "uniq_projects_org_key";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_projects_org_status";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_projects_name_trgm";
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_projects_org_key" ON "projects" ("org_id", "key") WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX "idx_projects_org_status" ON "projects" ("org_id", "status") WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX "idx_projects_name_trgm" ON "projects" USING GIN ("name" gin_trgm_ops) WHERE deleted_at IS NULL;
--> statement-breakpoint

-- sprints: replace status index with partial
DROP INDEX IF EXISTS "idx_sprints_project_status";
--> statement-breakpoint
CREATE INDEX "idx_sprints_project_status" ON "sprints" ("project_id", "status") WHERE deleted_at IS NULL;
--> statement-breakpoint

-- ticket_comments: replace ticket index with partial
DROP INDEX IF EXISTS "idx_ticket_comments_ticket";
--> statement-breakpoint
CREATE INDEX "idx_ticket_comments_ticket" ON "ticket_comments" ("ticket_id") WHERE deleted_at IS NULL;
--> statement-breakpoint

ANALYZE "projects";
--> statement-breakpoint
ANALYZE "sprints";
--> statement-breakpoint
ANALYZE "ticket_comments";
