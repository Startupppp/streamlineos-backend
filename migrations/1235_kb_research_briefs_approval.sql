SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "kb_research_briefs" ADD COLUMN IF NOT EXISTS "approved_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "kb_research_briefs" ADD COLUMN IF NOT EXISTS "approved_by_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "kb_research_briefs" ADD CONSTRAINT "fk_kb_research_briefs_approved_by" FOREIGN KEY ("org_id", "approved_by_membership_id") REFERENCES "organization_members" ("org_id", "id") ON DELETE SET NULL ("approved_by_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "kb_research_briefs" VALIDATE CONSTRAINT "fk_kb_research_briefs_approved_by";
