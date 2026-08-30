-- 0606 — Make audit-log tenant/platform states mutually exclusive.
-- A platform event has no tenant: org_id IS NULL iff is_platform_event is true.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE audit_logs
  DROP CONSTRAINT IF EXISTS chk_audit_logs_tenant_or_platform;
--> statement-breakpoint
ALTER TABLE audit_logs
  ADD CONSTRAINT chk_audit_logs_tenant_or_platform
  CHECK ((org_id IS NULL) = is_platform_event)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE audit_logs
  VALIDATE CONSTRAINT chk_audit_logs_tenant_or_platform;
