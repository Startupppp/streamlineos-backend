SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_content_digest_live"
  ON "public"."kb_pages" ("org_id", (md5(trim(both from "content_text"))))
  WHERE "deleted_at" IS NULL AND "content_text" IS NOT NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS "public"."idx_kb_pages_org_content_md5_live";
