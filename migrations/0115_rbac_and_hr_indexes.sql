-- Add missing lookup indexes for RBAC and HR tables.
-- role_permissions: fast lookup by role alone and by org+role pair.
-- user_permissions: fast lookup by user within an org.
-- leave_requests: composite index for the common org+user+status filter pattern.

CREATE INDEX IF NOT EXISTS idx_role_permissions_role
    ON role_permissions(role);

CREATE INDEX IF NOT EXISTS idx_role_permissions_org_role
    ON role_permissions(org_id, role);

CREATE INDEX IF NOT EXISTS idx_user_permissions_user_org
    ON user_permissions(user_id, org_id);

CREATE INDEX IF NOT EXISTS idx_leave_requests_org_user_status
    ON leave_requests(org_id, user_id, status);
