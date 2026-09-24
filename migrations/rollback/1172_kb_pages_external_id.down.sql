SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "public"."uniq_kb_pages_external_ref";
--> statement-breakpoint

ALTER TABLE "public"."kb_pages"
  DROP CONSTRAINT IF EXISTS "chk_kb_pages_external_ref_paired";
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" DROP COLUMN IF EXISTS "external_source";
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" DROP COLUMN IF EXISTS "external_id";
