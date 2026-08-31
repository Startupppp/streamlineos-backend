SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sprints_org_status" ON "build"."sprints" ("org_id", "status") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_space_sort" ON "public"."kb_pages" ("org_id", "space_id", "sort_order", "id") WHERE "deleted_at" IS NULL;
