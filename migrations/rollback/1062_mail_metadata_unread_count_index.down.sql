-- 1062 DOWN — drops the mail metadata unread-count index.
--
-- @reopens-a-defect: UnifiedInboxService.countMailUnread falls back to a sequential
-- scan of the tenant's entire mail_message_metadata table with a per-row is_read
-- filter on every page load for the unified-inbox badge. Measured at ~5,000 buffers
-- on a 200k-row table without this index.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_mail_metadata_unread_count";
