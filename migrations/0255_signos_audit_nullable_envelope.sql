-- Template/bulk-job/admin-setting audit events are tenant-scoped, not envelope-scoped.
ALTER TABLE sign_audit_events ALTER COLUMN envelope_id DROP NOT NULL;
