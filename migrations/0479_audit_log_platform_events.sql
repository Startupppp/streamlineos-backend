-- c16-05: Make audit_logs.org_id non-ambiguous.
-- Platform-level events (no tenant) are now represented by is_platform_event = true.
-- The CHECK constraint rejects any row with neither an org_id nor the platform flag,
-- so absence of org_id is no longer ambiguous.
--
-- Step order:
--   1. Add column (nullable-safe, no lock beyond an ACCESS EXCLUSIVE for the catalog write).
--   2. Back-fill existing NULL org_id rows as platform events.
--   3. Add constraint NOT VALID (online-safe, validates only new writes immediately).
--   4. VALIDATE CONSTRAINT (scans existing rows without holding an ACCESS EXCLUSIVE).

SET lock_timeout = '5s';

ALTER TABLE audit_logs
  ADD COLUMN is_platform_event boolean NOT NULL DEFAULT false;

UPDATE audit_logs
  SET is_platform_event = true
WHERE org_id IS NULL;

ALTER TABLE audit_logs
  ADD CONSTRAINT chk_audit_logs_tenant_or_platform
  CHECK (org_id IS NOT NULL OR is_platform_event = true)
  NOT VALID;

ALTER TABLE audit_logs
  VALIDATE CONSTRAINT chk_audit_logs_tenant_or_platform;
