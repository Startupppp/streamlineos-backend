-- Rollback for 1207_kb_version_restore_audit
-- Drops the restore audit table. All recorded audit rows are lost.
SET lock_timeout = '5s';
--> statement-breakpoint

DROP TABLE IF EXISTS "public"."kb_version_restore_audit";
--> statement-breakpoint
