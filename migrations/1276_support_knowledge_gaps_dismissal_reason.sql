SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "support_knowledge_gaps" ADD COLUMN IF NOT EXISTS "dismissal_reason" text;
