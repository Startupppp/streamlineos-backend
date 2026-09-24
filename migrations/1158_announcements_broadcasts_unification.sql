-- 1158 — make broadcasts the single source of truth for an org-wide admin message.
-- Rollback: migrations/rollback/1158_announcements_broadcasts_unification.down.sql
--
-- Two tables model one user-facing concept. `announcements` (hr) backs the Home widget;
-- `broadcasts` (common) backs the Broadcasts admin surface AND is the `broadcast` source of the
-- unified Inbox (unified-inbox-sources.ts:179 -> BroadcastsService.listInboxPage). Nothing ever
-- joined the two, which is why an announcement posted on Home never reached the Inbox.
--
-- broadcasts wins. It is the richer table — audience targeting in broadcast_audience_targets,
-- dismissal receipts in broadcast_read_receipts, a publish lifecycle, priority/category/type —
-- and it is already wired into the Inbox. It lacked exactly two things the Home widget uses:
-- is_pinned and expires_at. This migration adds them and folds the live announcements rows in.
--
-- WHAT `VISIBLE` MEANS HERE, READ OFF THE CONSUMER RATHER THAN GUESSED
-- -------------------------------------------------------------------
-- BroadcastsService.listInboxPage filters status = 'SENT' and nothing else about lifecycle, so
-- 'SENT' is the only status the Inbox treats as visible. broadcast_status also has SCHEDULED,
-- QUEUED, SENDING, CANCELLED and FAILED; none of them reach a user. Backfilled rows are therefore
-- written as 'SENT' with sent_at set, not 'PUBLISHED' (which is not a member of the enum) and not
-- 'QUEUED' (which would arrive nowhere).
--
-- audience_type is 'all'. resolveAudienceFilter short-circuits on it, so no
-- broadcast_audience_targets rows are needed; announcements had target_type 'ALL' and no
-- per-recipient targeting, so this is the faithful mapping and not a widening.
--
-- WHY THE BACKFILL IS NARROWER THAN "EVERY NON-DRAFT ROW"
-- ------------------------------------------------------
-- The Inbox has no expiry predicate today, so an expired announcement folded into broadcasts
-- would appear in every member's Inbox as a new unread item, years after it stopped being shown
-- on Home. The backfill is restricted to rows that are visible on Home at the moment it runs —
-- non-DRAFT and not expired. That is exactly the set a user can see now, so no user gains an
-- item they were not already being shown. Expired and DRAFT announcements stay in
-- `announcements`, which this migration does not touch.
--
-- 1158 pairs with the application change that adds
-- (expires_at IS NULL OR expires_at > now()) to listInboxPage, so expiry becomes a property of
-- the unified concept. That predicate is inert for every broadcast that exists today: expires_at
-- is NULL on all of them until a Home post sets it.
--
-- COMPATIBILITY
-- -------------
-- `announcements`, `announcement_targets` and `announcement_reads` are left exactly as they are.
-- Nothing is dropped, nothing is altered. After this migration they are a read-only historical
-- record with no writer. Retiring them is a separate, later contraction with its own rollback.
--
-- The backfill is guarded by NOT EXISTS on (org_id, created_by, title, message, created_at), so
-- re-running it cannot double-insert.
--
-- NOT APPLIED. No non-production PostgreSQL is reachable from the machine this was authored on,
-- so this file has never been executed and its DO-block verification has never run. Replay it on
-- an empty database (BE-66) before believing any of the above.
--
-- No CONCURRENTLY; drizzle-kit migrate wraps this file in one transaction. Precedent 1108.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "public"."broadcasts"
  ADD COLUMN IF NOT EXISTS "is_pinned" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

ALTER TABLE "public"."broadcasts"
  ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
--> statement-breakpoint

-- BE-44: org_id leads, then the equality filters the Home read supplies, then the columns it
-- orders by. BE-79: the RLS qual is not leakproof, so org_id has to be inside the index or the
-- planner heap-fetches every candidate row to evaluate app.current_org_id().
-- DashboardAnnouncementsService.getActiveAnnouncements filters org_id, status, audience_type and
-- orders by is_pinned DESC, created_at DESC — a uniformly-reversed ORDER BY, which a plain
-- ascending btree answers with a backward scan.
CREATE INDEX IF NOT EXISTS "idx_broadcasts_org_home_announcements"
  ON "public"."broadcasts" ("org_id", "status", "audience_type", "is_pinned", "created_at");
--> statement-breakpoint

-- announcements.publish_at / expires_at / created_at / updated_at are `timestamp` without time
-- zone (0000_light_vance_astro.sql:4307). AT TIME ZONE 'UTC' reads them as UTC instants rather
-- than leaving the result at the mercy of the session TimeZone.
INSERT INTO "public"."broadcasts" (
  "org_id", "title", "message", "type", "priority", "category", "channels",
  "audience", "audience_type", "status", "scheduled_at", "sent_at",
  "recipient_count", "delivered_count", "is_pinned", "expires_at",
  "created_by", "created_at", "updated_at"
)
SELECT
  a."org_id",
  a."title",
  a."content",
  'INFO'::notification_type,
  'NORMAL'::notification_priority,
  'SYSTEM'::notification_category,
  '["IN_APP"]'::jsonb,
  '{"type": "all"}'::jsonb,
  'all'::broadcast_audience_type,
  'SENT'::broadcast_status,
  a."publish_at" AT TIME ZONE 'UTC',
  COALESCE(a."publish_at", a."created_at") AT TIME ZONE 'UTC',
  0,
  0,
  a."is_pinned",
  a."expires_at" AT TIME ZONE 'UTC',
  a."author_id",
  a."created_at" AT TIME ZONE 'UTC',
  a."updated_at" AT TIME ZONE 'UTC'
FROM "public"."announcements" a
WHERE a."status" <> 'DRAFT'
  AND a."target_type" = 'ALL'
  AND (a."expires_at" IS NULL OR (a."expires_at" AT TIME ZONE 'UTC') > now())
  AND NOT EXISTS (
    SELECT 1 FROM "public"."broadcasts" b
     WHERE b."org_id" = a."org_id"
       AND b."created_by" = a."author_id"
       AND b."title" = a."title"
       AND b."message" = a."content"
       AND b."created_at" = (a."created_at" AT TIME ZONE 'UTC')
  );
--> statement-breakpoint

DO $$
DECLARE
  pinned_default text;
  pinned_notnull boolean;
  expires_type text;
  missing bigint;
  leaked bigint;
  unsent bigint;
BEGIN
  SELECT column_default, (is_nullable = 'NO')
    INTO pinned_default, pinned_notnull
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'broadcasts' AND column_name = 'is_pinned';
  IF pinned_default IS NULL THEN
    RAISE EXCEPTION '1158: broadcasts.is_pinned is absent or has no default';
  END IF;
  IF pinned_default NOT LIKE 'false%' THEN
    RAISE EXCEPTION '1158: broadcasts.is_pinned defaults to %, not false', pinned_default;
  END IF;
  IF NOT pinned_notnull THEN
    RAISE EXCEPTION '1158: broadcasts.is_pinned is nullable, so the Home ordering can sort NULLs';
  END IF;

  SELECT data_type INTO expires_type
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'broadcasts' AND column_name = 'expires_at';
  IF expires_type IS NULL THEN
    RAISE EXCEPTION '1158: broadcasts.expires_at is absent';
  END IF;
  IF expires_type <> 'timestamp with time zone' THEN
    RAISE EXCEPTION '1158: broadcasts.expires_at is %, not timestamptz', expires_type;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'idx_broadcasts_org_home_announcements' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION '1158: idx_broadcasts_org_home_announcements was not created';
  END IF;

  SELECT count(*) INTO missing
    FROM "public"."announcements" a
   WHERE a."status" <> 'DRAFT'
     AND a."target_type" = 'ALL'
     AND (a."expires_at" IS NULL OR (a."expires_at" AT TIME ZONE 'UTC') > now())
     AND NOT EXISTS (
       SELECT 1 FROM "public"."broadcasts" b
        WHERE b."org_id" = a."org_id"
          AND b."created_by" = a."author_id"
          AND b."title" = a."title"
          AND b."message" = a."content"
          AND b."created_at" = (a."created_at" AT TIME ZONE 'UTC')
     );
  IF missing > 0 THEN
    RAISE EXCEPTION '1158: % org-wide announcements have no broadcast twin, the Inbox would still not see them', missing;
  END IF;

  SELECT count(*) INTO leaked
    FROM "public"."announcements" a
    JOIN "public"."broadcasts" b
      ON b."org_id" = a."org_id"
     AND b."created_by" = a."author_id"
     AND b."title" = a."title"
     AND b."message" = a."content"
     AND b."created_at" = (a."created_at" AT TIME ZONE 'UTC')
   WHERE a."target_type" <> 'ALL';
  IF leaked > 0 THEN
    RAISE EXCEPTION '1158: % audience-targeted announcements were copied to org-wide broadcasts, widening who can read them', leaked;
  END IF;

  SELECT count(*) INTO unsent
    FROM "public"."announcements" a
    JOIN "public"."broadcasts" b
      ON b."org_id" = a."org_id"
     AND b."created_by" = a."author_id"
     AND b."title" = a."title"
     AND b."message" = a."content"
     AND b."created_at" = (a."created_at" AT TIME ZONE 'UTC')
   WHERE a."status" <> 'DRAFT'
     AND (a."expires_at" IS NULL OR (a."expires_at" AT TIME ZONE 'UTC') > now())
     AND (b."status" <> 'SENT' OR b."sent_at" IS NULL OR b."audience_type" <> 'all');
  IF unsent > 0 THEN
    RAISE EXCEPTION '1158: % backfilled rows are not SENT/all, listInboxPage would skip them', unsent;
  END IF;
END
$$;
