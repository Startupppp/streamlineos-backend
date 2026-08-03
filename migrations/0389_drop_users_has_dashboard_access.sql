SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 0389 — drop `users.has_dashboard_access`.
--
-- The column was a second, weaker `is_active`: every real creation path wrote
-- `true` (signup, invite acceptance, employee onboarding, token bootstrap,
-- seeds) while the column default was `false`, so any row created outside those
-- paths was locked out of the entire application shell with no screen able to
-- explain or repair it. The only gate it drove replaced the whole authenticated
-- shell with a "not activated" page; the only other reader used it as a proxy
-- for "this person logs in" when picking CRM lead assignees, which `is_active`
-- plus the `crm:leads:assign` permission already decide.
--
-- Home/dashboard reachability is not a permission: every member of an
-- organization reaches the Home module, and what they see inside it is decided
-- by RBAC and module enablement.
--
-- Verified before dropping: zero symbol references to `hasDashboardAccess` in
-- the backend, zero raw-SQL references to `has_dashboard_access`, and no FK,
-- index, view, or constraint depends on it.
--
-- DROP COLUMN takes ACCESS EXCLUSIVE on `users`, but it is a catalog-only
-- operation (Postgres marks the attribute dropped rather than rewriting the
-- table), so it is fast. `lock_timeout` is set so it fails fast instead of
-- queueing behind a long-running reader and blocking every writer behind it.

ALTER TABLE "users" DROP COLUMN IF EXISTS "has_dashboard_access";
