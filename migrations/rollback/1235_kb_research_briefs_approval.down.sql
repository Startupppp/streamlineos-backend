SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_kb_research_briefs_approved_by";
--> statement-breakpoint
ALTER TABLE "kb_research_briefs" DROP CONSTRAINT IF EXISTS "fk_kb_research_briefs_approved_by";
--> statement-breakpoint
ALTER TABLE "kb_research_briefs" DROP COLUMN IF EXISTS "approved_by_membership_id";
--> statement-breakpoint
ALTER TABLE "kb_research_briefs" DROP COLUMN IF EXISTS "approved_at";
