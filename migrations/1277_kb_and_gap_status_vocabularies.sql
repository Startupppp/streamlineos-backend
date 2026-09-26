SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "kb_pages" ADD CONSTRAINT "kb_pages_status_check" CHECK ("status" IN ('draft', 'in_review', 'published', 'archived')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "kb_pages" VALIDATE CONSTRAINT "kb_pages_status_check";
--> statement-breakpoint
ALTER TABLE "kb_pages" ADD CONSTRAINT "kb_pages_trust_state_check" CHECK ("trust_state" IN ('unverified', 'verified', 'verification_expired')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "kb_pages" VALIDATE CONSTRAINT "kb_pages_trust_state_check";
--> statement-breakpoint
ALTER TABLE "support_knowledge_gaps" ADD CONSTRAINT "support_knowledge_gaps_status_check" CHECK ("status" IN ('OPEN', 'DRAFTED', 'ROUTED', 'PUBLISHED', 'DISMISSED')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "support_knowledge_gaps" VALIDATE CONSTRAINT "support_knowledge_gaps_status_check";
