SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "kb_research_briefs" DROP COLUMN IF EXISTS "model";
--> statement-breakpoint
ALTER TABLE "kb_research_briefs" DROP COLUMN IF EXISTS "provider";
--> statement-breakpoint
ALTER TABLE "kb_research_briefs" DROP COLUMN IF EXISTS "cost_credits";
