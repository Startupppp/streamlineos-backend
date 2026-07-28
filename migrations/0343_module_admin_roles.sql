SET statement_timeout = 0;
-- 0343 — populate permissions.module_key and seed permission_supported_scopes
-- =============================================================================
-- 1. permissions.module_key
--    Derived from the first colon-separated segment of each permission name.
--    Decision for 2-segment keys (one colon only):
--      branch:view     → module_key = 'branch'
--      self:payslips   → module_key = 'self'
--      audit-log:read  → module_key = 'audit-log'
--    These do NOT reference modules_catalog — module_key is unrestricted text.
--
-- 2. permission_supported_scopes
--    Scopable permissions (marked scopable: true in the TypeScript catalog)
--    receive rows for 'all', 'team', and 'own'. All other permissions receive
--    only 'all'. 'none' is intentionally omitted — it represents denial, not
--    an assignable grant scope.
--
-- Both statements are safe on an empty permissions table (0 rows affected).
-- =============================================================================

UPDATE "permissions"
SET "module_key" = split_part("name", ':', 1)
WHERE "module_key" IS NULL;
--> statement-breakpoint

INSERT INTO "permission_supported_scopes" ("permission_key", "scope")
SELECT "name", 'all'::data_scope
FROM "permissions"
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO "permission_supported_scopes" ("permission_key", "scope")
SELECT "name", 'team'::data_scope
FROM "permissions"
WHERE "name" IN (
  'accounting:approvals:read',
  'accounting:journal:read',
  'accounting:payables:read',
  'accounting:receivables:read',
  'build:manage',
  'build:timesheets:manage',
  'crm:clients:read',
  'crm:contacts:view',
  'crm:deals:read',
  'crm:leads:delete',
  'crm:leads:update',
  'crm:leads:view',
  'crm:quotes:read',
  'crm:tasks:update',
  'crm:tasks:view',
  'hr:attendance:manage',
  'hr:employees:manage',
  'hr:employees:read',
  'hr:expenses:approve',
  'hr:leaves:approve',
  'hr:payroll:view',
  'inventory:products:read',
  'inventory:purchase-orders:read',
  'inventory:sales-orders:read',
  'inventory:stock:read',
  'kb:articles:view',
  'kb:spaces:view',
  'payroll:runs:view',
  'support:tickets:internal_note',
  'support:tickets:manage',
  'support:tickets:reply',
  'support:tickets:view',
  'surveys:delete',
  'surveys:publish',
  'surveys:update',
  'surveys:view',
  'timesheets:approvals:manage',
  'timesheets:approvals:view',
  'timesheets:entries:view',
  'timesheets:exceptions:view',
  'timesheets:reports:view',
  'timesheets:team:view'
)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO "permission_supported_scopes" ("permission_key", "scope")
SELECT "name", 'own'::data_scope
FROM "permissions"
WHERE "name" IN (
  'accounting:approvals:read',
  'accounting:journal:read',
  'accounting:payables:read',
  'accounting:receivables:read',
  'build:manage',
  'build:timesheets:manage',
  'crm:clients:read',
  'crm:contacts:view',
  'crm:deals:read',
  'crm:leads:delete',
  'crm:leads:update',
  'crm:leads:view',
  'crm:quotes:read',
  'crm:tasks:update',
  'crm:tasks:view',
  'hr:attendance:manage',
  'hr:employees:manage',
  'hr:employees:read',
  'hr:expenses:approve',
  'hr:leaves:approve',
  'hr:payroll:view',
  'inventory:products:read',
  'inventory:purchase-orders:read',
  'inventory:sales-orders:read',
  'inventory:stock:read',
  'kb:articles:view',
  'kb:spaces:view',
  'payroll:runs:view',
  'support:tickets:internal_note',
  'support:tickets:manage',
  'support:tickets:reply',
  'support:tickets:view',
  'surveys:delete',
  'surveys:publish',
  'surveys:update',
  'surveys:view',
  'timesheets:approvals:manage',
  'timesheets:approvals:view',
  'timesheets:entries:view',
  'timesheets:exceptions:view',
  'timesheets:reports:view',
  'timesheets:team:view'
)
ON CONFLICT DO NOTHING;
