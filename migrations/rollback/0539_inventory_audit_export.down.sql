-- 0539.down — Drop the audit export job table.
--
-- Its indexes and RLS policy go with the table.
--
-- @data-loss: inv_audit_export_jobs
SET lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_audit_export_jobs" CASCADE;
