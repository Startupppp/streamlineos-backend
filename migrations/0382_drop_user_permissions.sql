SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 0382 — drop the per-user permission override table.
-- user_permissions was never written to: no INSERT or UPDATE path exists anywhere
-- in application code, seeds, or scripts (verified by grep 2026-08-01).
-- Read paths (allow-side in access.service computeUserPermissions,
-- deny-side getUserDeniedPermissions, computeMembersWithPermission join,
-- rbac.service getUserPermissions, org-membership cleanup DELETE) are all
-- removed in the same commit. DROP TABLE removes associated indexes, constraints,
-- and RLS policies automatically.
-- Inbound FKs: none (verified — no table references user_permissions.id).

DROP TABLE IF EXISTS public.user_permissions;
