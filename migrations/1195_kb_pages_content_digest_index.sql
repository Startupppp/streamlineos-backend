SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_pages') IS NULL THEN
    RAISE EXCEPTION '1195 precondition: public.kb_pages is absent — this is not a Knowledge database';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.kb_pages'::regclass
      AND attname = 'content_text'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION '1195 precondition: public.kb_pages.content_text is absent';
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_content_digest_live"
  ON "public"."kb_pages" ("org_id", (md5(trim(both from "content_text"))))
  WHERE "deleted_at" IS NULL AND "content_text" IS NOT NULL;
--> statement-breakpoint

ANALYZE "public"."kb_pages";
