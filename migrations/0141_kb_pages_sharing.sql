ALTER TABLE "kb_pages" ADD COLUMN IF NOT EXISTS "visibility" text NOT NULL DEFAULT 'org';
--> statement-breakpoint
ALTER TABLE "kb_pages" ADD COLUMN IF NOT EXISTS "public_token" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_pages_public_token" ON "kb_pages" ("public_token");
