SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "support_knowledge_gaps" DROP CONSTRAINT IF EXISTS "support_knowledge_gaps_status_check";
--> statement-breakpoint
ALTER TABLE "kb_pages" DROP CONSTRAINT IF EXISTS "kb_pages_trust_state_check";
--> statement-breakpoint
ALTER TABLE "kb_pages" DROP CONSTRAINT IF EXISTS "kb_pages_status_check";
