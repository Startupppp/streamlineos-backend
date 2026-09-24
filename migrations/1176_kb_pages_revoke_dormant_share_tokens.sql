SET lock_timeout = '5s';
--> statement-breakpoint

-- Companion to the setVisibility fix that clears public_token/public_token_hash when a
-- page leaves "public". Rows unshared BEFORE that fix still carry their old token, and
-- the mint path only issues a new one when the existing token is NULL — so re-sharing
-- such a page resurrects the previously revoked URL. This clears those dormant tokens
-- once so every re-share mints a fresh credential.
--
-- Rows are dormant, not live: getPublicPage additionally requires visibility = 'public',
-- so no link that resolves today stops resolving because of this migration.
--
-- Soft-deleted pages are deliberately left alone. A page in the trash keeps its token so
-- that restoring it restores the same share link.

DO $$
BEGIN
  IF to_regclass('public.kb_pages') IS NULL THEN
    RAISE EXCEPTION '1176 precondition: public.kb_pages is absent — this is not a Knowledge database';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.kb_pages'::regclass
      AND attname = 'public_token_hash'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION '1176 precondition: public.kb_pages.public_token_hash is absent — apply 1171 first';
  END IF;
END $$;
--> statement-breakpoint

UPDATE "public"."kb_pages"
SET "public_token" = NULL,
    "public_token_hash" = NULL
WHERE "visibility" <> 'public'
  AND ("public_token" IS NOT NULL OR "public_token_hash" IS NOT NULL);
