-- 1080 — chat invite links gain expiry, a usage cap and a per-link counter.
--
-- WHAT CHANGES. `chat_channel_invite_links` gains three columns:
--   expires_at  timestamp NULL  — NULL means the link never expires.
--   max_uses    integer   NULL  — NULL means unlimited uses.
--   use_count   integer   NOT NULL DEFAULT 0
--                               — incremented once per new channel membership
--                                 admitted through this link.
--
-- BACKWARD COMPATIBILITY. All three are nullable-tolerant for existing rows.
-- Existing rows get use_count = 0 via the backfill below, expires_at = NULL
-- and max_uses = NULL, so they behave exactly as before (valid, unlimited).
-- `use_count` is then hardened to NOT NULL DEFAULT 0 with the additive
-- add-nullable → backfill → CHECK NOT VALID → VALIDATE → SET NOT NULL pattern
-- so no table rewrite is needed and the lock is held for microseconds.
--
-- CONCURRENT MINT SAFETY. Multiple simultaneous `getOrCreateInviteLink` calls
-- for the same channel can each see no active link and each try to insert.
-- A partial unique index on (org_id, channel_id) WHERE revoked_at IS NULL
-- makes only one insert win; the service handles the ON CONFLICT by re-reading
-- the winner's row. Links that are expired or exhausted but not explicitly
-- revoked are revoked by the service before it inserts a fresh one, so the
-- partial index never blocks a legitimate re-mint.
--
-- LOCKING. ADD COLUMN on a nullable column and CREATE UNIQUE INDEX are each
-- catalog-only changes and hold ACCESS EXCLUSIVE for microseconds once granted.
-- `lock_timeout` makes this fail fast rather than queue in front of chat tables.
-- use_count's NOT NULL hardening (CHECK NOT VALID → VALIDATE → SET NOT NULL)
-- avoids a full table scan for the SET NOT NULL step.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "chat_channel_invite_links" ADD COLUMN IF NOT EXISTS "expires_at" timestamp;
--> statement-breakpoint

ALTER TABLE "chat_channel_invite_links" ADD COLUMN IF NOT EXISTS "max_uses" integer;
--> statement-breakpoint

ALTER TABLE "chat_channel_invite_links" ADD COLUMN IF NOT EXISTS "use_count" integer;
--> statement-breakpoint

UPDATE "chat_channel_invite_links" SET "use_count" = 0 WHERE "use_count" IS NULL;
--> statement-breakpoint

ALTER TABLE "chat_channel_invite_links"
  ADD CONSTRAINT "chk_chat_invite_links_use_count_not_null"
  CHECK ("use_count" IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE "chat_channel_invite_links"
  VALIDATE CONSTRAINT "chk_chat_invite_links_use_count_not_null";
--> statement-breakpoint

ALTER TABLE "chat_channel_invite_links" ALTER COLUMN "use_count" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "chat_channel_invite_links" ALTER COLUMN "use_count" SET DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "chat_channel_invite_links"
  DROP CONSTRAINT "chk_chat_invite_links_use_count_not_null";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_chat_invite_active_link_channel"
  ON "chat_channel_invite_links" ("org_id", "channel_id")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint

DO $$
DECLARE
  nulls bigint;
  col_notnull boolean;
  col_default text;
BEGIN
  SELECT count(*) INTO nulls
    FROM chat_channel_invite_links WHERE use_count IS NULL;
  IF nulls > 0 THEN
    RAISE EXCEPTION '1080: % chat_channel_invite_links rows still have a null use_count', nulls;
  END IF;

  SELECT a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
    INTO col_notnull, col_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'chat_channel_invite_links'::regclass
     AND a.attname = 'use_count'
     AND NOT a.attisdropped;
  IF NOT FOUND THEN
    RAISE EXCEPTION '1080: chat_channel_invite_links.use_count does not exist';
  END IF;
  IF NOT col_notnull THEN
    RAISE EXCEPTION '1080: chat_channel_invite_links.use_count is still nullable';
  END IF;
  IF col_default IS NULL THEN
    RAISE EXCEPTION '1080: chat_channel_invite_links.use_count has no DEFAULT';
  END IF;

  PERFORM 1 FROM pg_attribute
   WHERE attrelid = 'chat_channel_invite_links'::regclass
     AND attname = 'expires_at' AND NOT attisdropped;
  IF NOT FOUND THEN
    RAISE EXCEPTION '1080: chat_channel_invite_links.expires_at does not exist';
  END IF;

  PERFORM 1 FROM pg_attribute
   WHERE attrelid = 'chat_channel_invite_links'::regclass
     AND attname = 'max_uses' AND NOT attisdropped;
  IF NOT FOUND THEN
    RAISE EXCEPTION '1080: chat_channel_invite_links.max_uses does not exist';
  END IF;

  PERFORM 1 FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
   WHERE i.relname = 'uniq_chat_invite_active_link_channel'
     AND x.indrelid = 'chat_channel_invite_links'::regclass
     AND x.indisunique;
  IF NOT FOUND THEN
    RAISE EXCEPTION '1080: uniq_chat_invite_active_link_channel was not created or is not unique';
  END IF;
END
$$;
