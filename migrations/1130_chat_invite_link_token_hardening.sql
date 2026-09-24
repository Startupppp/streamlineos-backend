-- Migration 0459 added token_hash and token_encrypted alongside the legacy plaintext
-- token column, backfilled token_hash from the plaintext for existing rows, and stopped
-- writing new plaintext (new inserts carry token = NULL).  The encrypted fallback could
-- not be backfilled in SQL because it requires the application's ENCRYPTION_KEY.
--
-- This migration completes the hardening:
--   1. Preflight — refuse if any row still lacks a hash (would mean 0459 did not run or
--      an out-of-band insert bypassed the service; the operator must investigate before
--      proceeding).
--   2. Drop the plaintext unique index; it indexes a secret at rest and is redundant
--      now that the hash index handles lookup uniqueness.
--   3. Erase remaining plaintext values (rows where token_encrypted is NULL because 0459
--      could not backfill the cipher).  Those links remain joinable via token_hash.
--      When an admin next opens the invite dialog the service detects a null readableToken,
--      auto-revokes the old row and mints a new fully-encrypted link.
--   4. Add NOT NULL to token_hash using the two-step NOT VALID / VALIDATE pattern to
--      avoid holding ACCESS EXCLUSIVE for a full-table scan.

SET lock_timeout = '5s';
--> statement-breakpoint
DO $$
DECLARE
  null_hash_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO null_hash_count
  FROM "chat_channel_invite_links"
  WHERE "token_hash" IS NULL;

  IF null_hash_count > 0 THEN
    RAISE EXCEPTION
      'Migration 1130 blocked: % row(s) in chat_channel_invite_links have a NULL token_hash. '
      'Migration 0459 should have backfilled token_hash for every pre-existing row. '
      'Inspect those rows (SELECT id, org_id, channel_id FROM chat_channel_invite_links '
      'WHERE token_hash IS NULL;) and resolve before re-running.',
      null_hash_count;
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_chat_invite_link_token";
--> statement-breakpoint
UPDATE "chat_channel_invite_links"
SET "token" = NULL
WHERE "token" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_channel_invite_links"
  ADD CONSTRAINT "chat_invite_link_token_hash_not_null"
  CHECK ("token_hash" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "chat_channel_invite_links"
  VALIDATE CONSTRAINT "chat_invite_link_token_hash_not_null";
--> statement-breakpoint
ALTER TABLE "chat_channel_invite_links"
  ALTER COLUMN "token_hash" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_channel_invite_links"
  DROP CONSTRAINT "chat_invite_link_token_hash_not_null";
