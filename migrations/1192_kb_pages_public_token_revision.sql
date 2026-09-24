SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_pages') IS NULL THEN
    RAISE EXCEPTION '1192 precondition: public.kb_pages is absent — this is not a Knowledge database';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.kb_pages'::regclass
      AND attname = 'public_token_hash'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION '1192 precondition: public.kb_pages.public_token_hash is absent — apply 1171 first';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" ADD COLUMN IF NOT EXISTS "public_token_revision" integer NOT NULL DEFAULT 1;
