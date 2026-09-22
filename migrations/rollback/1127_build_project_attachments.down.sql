-- Rollback for migration 1127.
--
-- Drops the build.project_attachments table and its cursor index. All
-- attachment metadata records are permanently deleted. WARNING: the
-- storage_key column holds paths to objects in external blob storage
-- (S3-equivalent); this rollback issues no storage-side DELETE — those
-- objects become orphaned and must be reconciled manually. The forward
-- migration stores no cleanup hook or trigger, so there is no automatic
-- record of which keys to purge.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_project_attachments_org_project_cursor";
--> statement-breakpoint
DROP TABLE IF EXISTS "build"."project_attachments";
