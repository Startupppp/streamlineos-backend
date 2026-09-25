-- Rollback for 1200_kb_linked_documents. Destructive: every link and its audience is lost, and the three
-- switches on kb_settings are dropped (back to "off" by absence).
-- Run 1201's rollback first: its function and triggers read these tables.
SET lock_timeout = '5s';
--> statement-breakpoint

DROP TABLE IF EXISTS "public"."kb_linked_document_audiences";
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."kb_linked_documents";
--> statement-breakpoint

ALTER TABLE "public"."kb_settings" DROP CONSTRAINT IF EXISTS "chk_kb_settings_hrms_flag_order";
--> statement-breakpoint
ALTER TABLE "public"."kb_settings" DROP COLUMN IF EXISTS "hrms_kb_ai_enabled";
--> statement-breakpoint
ALTER TABLE "public"."kb_settings" DROP COLUMN IF EXISTS "hrms_kb_search_enabled";
--> statement-breakpoint
ALTER TABLE "public"."kb_settings" DROP COLUMN IF EXISTS "hrms_kb_link_enabled";
