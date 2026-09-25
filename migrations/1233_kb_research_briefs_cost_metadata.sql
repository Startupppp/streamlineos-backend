SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "kb_research_briefs" ADD COLUMN IF NOT EXISTS "cost_credits" integer;
--> statement-breakpoint
ALTER TABLE "kb_research_briefs" ADD COLUMN IF NOT EXISTS "provider" text;
--> statement-breakpoint
ALTER TABLE "kb_research_briefs" ADD COLUMN IF NOT EXISTS "model" text;
