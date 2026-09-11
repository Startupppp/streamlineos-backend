-- 0912 — feedbucket joins the module catalogue it was already a module in
-- =============================================================================
-- `feedbucket` is a shipped, plan-gated module: it has a MODULE_REGISTRY entry
-- (`planGated: true`, `ladder: "delegable"`), thirteen catalogued permission
-- keys, controllers, services and a Nest module. It has never had a
-- `modules_catalog` row. 0337 seeded that table from MODULE_CATALOG as it stood
-- then, and feedbucket was added to the code catalogue afterwards without a
-- migration following it — the same drift 0463 corrected for `notifications`.
--
-- Two foreign keys make the missing row fatal rather than cosmetic:
--
--   * `org_modules.module_key → modules_catalog.module_key` (0337) means no
--     organisation can enable feedbucket at all.
--   * `roles.module_key → modules_catalog.module_key` (0634, VALIDATE'd) means
--     `seedSystemRolesForOrg` cannot insert FEEDBUCKET_MODULE_ADMIN — and it
--     derives that role from MODULE_CATALOG on every call. So organisation
--     creation raises `fk_roles_module` partway through seeding, leaving the new
--     tenant with the roles alphabetically before feedbucket and none after.
--
-- 0634 could validate only because no `roles` row named feedbucket yet: the
-- constraint went on cleanly and the breakage lands on the next org created.
--
-- Non-core and not paid-only, matching its peers in the gated group
-- (support, surveys, sign, timesheets); sort_order continues that run at 13.
--
-- Idempotent: inserts only when absent, and corrects the flags of a row that is
-- already there, so a database that has somehow acquired one is left in
-- agreement rather than duplicated.
-- =============================================================================

SET lock_timeout = '5s';

INSERT INTO modules_catalog (module_key, name, is_core, is_paid_only, sort_order, status)
VALUES ('feedbucket', 'Feedbucket', false, false, 13, 'ACTIVE')
ON CONFLICT (module_key) DO UPDATE
   SET is_core = false,
       is_paid_only = false;
