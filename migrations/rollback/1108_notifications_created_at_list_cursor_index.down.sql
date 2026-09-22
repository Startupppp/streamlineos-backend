-- Rollback for migration 1108.
-- The forward migration added a partial composite index on the notifications partitioned
-- table to serve the (org_id, membership_id, created_at DESC, id DESC) keyset for the
-- unified inbox cursor. The verification DO block was a creation-time assertion only —
-- it has no inverse schema effect. No data is lost.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_notifications_list_created_cursor";
