-- 0961_storage_file_quarantine DOWN — drops the quarantine record table and its indexes.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_fqr_idempotency_key";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_fqr_org_key_active";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_fqr_org_status_created";
--> statement-breakpoint
DROP TABLE IF EXISTS "file_quarantine_records";
