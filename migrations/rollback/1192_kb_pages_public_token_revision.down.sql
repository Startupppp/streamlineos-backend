SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" DROP COLUMN IF EXISTS "public_token_revision";
