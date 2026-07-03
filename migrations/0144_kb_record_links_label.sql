ALTER TABLE "kb_page_links" ALTER COLUMN "target_page_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "kb_page_links" ADD COLUMN IF NOT EXISTS "label" text;
