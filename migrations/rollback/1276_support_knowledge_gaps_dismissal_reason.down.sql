SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "support_knowledge_gaps" DROP COLUMN IF EXISTS "dismissal_reason";
