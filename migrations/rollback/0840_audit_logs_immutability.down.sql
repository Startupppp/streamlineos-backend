-- Rollback for 0840_audit_logs_immutability.sql
-- Restores UPDATE and DELETE privileges to streamline_app and drops the
-- SECURITY DEFINER helper function. After rollback, org-purge.service.ts
-- must also be reverted to the direct Drizzle UPDATE call.

GRANT UPDATE, DELETE ON TABLE public.audit_logs TO streamline_app;

DROP FUNCTION IF EXISTS app.nullify_audit_logs_org_id(text);
