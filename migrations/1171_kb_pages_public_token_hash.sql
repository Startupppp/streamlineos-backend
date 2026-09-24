SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_pages') IS NULL THEN
    RAISE EXCEPTION '1171 precondition: public.kb_pages is absent — this is not a Knowledge database';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'kb_pages'
      AND a.attname = 'public_token' AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION '1171 precondition: public.kb_pages.public_token is absent — nothing to hash';
  END IF;
  IF to_regprocedure('public.digest(text, text)') IS NULL THEN
    RAISE EXCEPTION '1171 precondition: pgcrypto digest() is unavailable — CREATE EXTENSION pgcrypto before this migration';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" ADD COLUMN IF NOT EXISTS "public_token_hash" text;
--> statement-breakpoint

UPDATE "public"."kb_pages"
  SET "public_token_hash" = encode(digest("public_token", 'sha256'), 'hex')
  WHERE "public_token" IS NOT NULL
    AND "public_token_hash" IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_pages_public_token_hash"
  ON "public"."kb_pages" ("public_token_hash")
  WHERE "public_token_hash" IS NOT NULL;
--> statement-breakpoint

DROP POLICY IF EXISTS "tenant_isolation" ON "public"."kb_pages";
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "public"."kb_pages" FOR ALL
  USING (
    "org_id" = app.current_org_id_or_null()
    OR "public_token_hash" = app.current_public_token_or_null()
  )
  WITH CHECK ("org_id" = app.current_org_id());
