SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_pages') IS NULL THEN
    RAISE EXCEPTION '1196 precondition: public.kb_pages is absent — this is not a Knowledge database';
  END IF;
  IF to_regclass('public.idx_kb_pages_org_content_digest_live') IS NULL THEN
    RAISE EXCEPTION '1196 precondition: idx_kb_pages_org_content_digest_live is absent — apply 1195 first';
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_content_md5_live"
  ON "public"."kb_pages" ("org_id", (md5("content_text")))
  WHERE "deleted_at" IS NULL AND "content_text" IS NOT NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS "public"."idx_kb_pages_org_content_digest_live";
--> statement-breakpoint

ANALYZE "public"."kb_pages";
