-- kb_pages governance columns
ALTER TABLE "kb_pages" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'draft';
--> statement-breakpoint
ALTER TABLE "kb_pages" ADD COLUMN IF NOT EXISTS "content_type" text NOT NULL DEFAULT 'note';
--> statement-breakpoint
ALTER TABLE "kb_pages" ADD COLUMN IF NOT EXISTS "trust_state" text NOT NULL DEFAULT 'unverified';
--> statement-breakpoint
ALTER TABLE "kb_pages" ADD COLUMN IF NOT EXISTS "owner_user_id" text;
--> statement-breakpoint
ALTER TABLE "kb_pages" ADD COLUMN IF NOT EXISTS "verified_by_id" text;
--> statement-breakpoint
ALTER TABLE "kb_pages" ADD COLUMN IF NOT EXISTS "verified_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "kb_pages" ADD COLUMN IF NOT EXISTS "next_review_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "kb_pages" ADD COLUMN IF NOT EXISTS "public_slug" text;
--> statement-breakpoint
ALTER TABLE "kb_pages"
  ADD CONSTRAINT "kb_pages_owner_user_id_users_id_fk"
  FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_pages"
  ADD CONSTRAINT "kb_pages_verified_by_id_users_id_fk"
  FOREIGN KEY ("verified_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_status" ON "kb_pages" ("org_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_next_review" ON "kb_pages" ("org_id", "next_review_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_pages_org_public_slug" ON "kb_pages" ("org_id", "public_slug") WHERE "public_slug" IS NOT NULL;
--> statement-breakpoint
-- kb_spaces governance columns
ALTER TABLE "kb_spaces" ADD COLUMN IF NOT EXISTS "type" text NOT NULL DEFAULT 'team';
--> statement-breakpoint
ALTER TABLE "kb_spaces" ADD COLUMN IF NOT EXISTS "color" text;
--> statement-breakpoint
ALTER TABLE "kb_spaces" ADD COLUMN IF NOT EXISTS "default_visibility" text NOT NULL DEFAULT 'org';
--> statement-breakpoint
ALTER TABLE "kb_spaces" ADD COLUMN IF NOT EXISTS "owning_team_id" text;
--> statement-breakpoint
ALTER TABLE "kb_spaces" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
-- kb_page_links governance columns
ALTER TABLE "kb_page_links" ADD COLUMN IF NOT EXISTS "target_type" text NOT NULL DEFAULT 'page';
--> statement-breakpoint
ALTER TABLE "kb_page_links" ADD COLUMN IF NOT EXISTS "target_id" text;
