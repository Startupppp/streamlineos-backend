-- 0942_storage_multipart_intents DOWN — drops the multipart upload intent table and its indexes.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS idx_mui_upload_id;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_mui_org_created;
--> statement-breakpoint
DROP TABLE IF EXISTS multipart_upload_intents;
