-- Rollback for migration 1158.
--
-- Reverses the unification: removes the broadcasts rows 1158 folded in from `announcements`,
-- then drops the index and the two columns it added.
--
-- @data-loss. Dropping is_pinned and expires_at discards every value written to them AFTER 1158
-- ran — that is, every pin and every expiry set through the Home announcements path once it
-- started writing broadcasts. The rows themselves survive; only those two facts about them are
-- lost. There is no way to keep them: they have nowhere else to live once the columns are gone.
--
-- `announcements` was never modified by 1158, so the pre-cutover rows are still there and the
-- reverted Home widget reads them again. No announcement is lost by rolling back.
--
-- The delete matches on (org_id, created_by, title, message, created_at) — the same natural key
-- the forward backfill used to stay idempotent. An admin-authored broadcast could in principle
-- collide with it, but only by sharing an org, an author, a title, a body AND a created_at to
-- the microsecond with an announcement row. Order matters: delete before dropping the columns,
-- because the delete narrows on is_pinned/expires_at agreement to lower even that risk.
--
-- broadcast_audience_targets and broadcast_read_receipts both carry
-- FOREIGN KEY (org_id, broadcast_id) REFERENCES broadcasts (org_id, id) ON DELETE CASCADE
-- (0964_ar02_canonical_tenant_fks_2.sql:150,161), so dismissal receipts recorded against a
-- backfilled row are removed with it rather than orphaned.
--
-- NOT APPLIED. Authored without a reachable non-production database; never executed.
--
-- No CONCURRENTLY; drizzle-kit migrate wraps this file in one transaction.

SET lock_timeout = '5s';
--> statement-breakpoint

DELETE FROM "public"."broadcasts" b
 USING "public"."announcements" a
 WHERE b."org_id" = a."org_id"
   AND b."created_by" = a."author_id"
   AND b."title" = a."title"
   AND b."message" = a."content"
   AND b."created_at" = (a."created_at" AT TIME ZONE 'UTC')
   AND b."audience_type" = 'all'
   AND b."status" = 'SENT'
   AND b."is_pinned" = a."is_pinned"
   AND b."expires_at" IS NOT DISTINCT FROM (a."expires_at" AT TIME ZONE 'UTC')
   AND a."status" <> 'DRAFT';
--> statement-breakpoint

DROP INDEX IF EXISTS "public"."idx_broadcasts_org_home_announcements";
--> statement-breakpoint

ALTER TABLE "public"."broadcasts" DROP COLUMN IF EXISTS "expires_at";
--> statement-breakpoint

ALTER TABLE "public"."broadcasts" DROP COLUMN IF EXISTS "is_pinned";
