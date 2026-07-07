ALTER TABLE "kb_page_versions" ADD COLUMN IF NOT EXISTS "content_text" text;
--> statement-breakpoint
ALTER TABLE "kb_page_versions" ADD COLUMN IF NOT EXISTS "change_summary" text;
