-- 0990 DOWN — removes the six backfilled keys from every system CUSTOMER_SUPPORT role and
-- bumps access_versions so cached resolutions are dropped. A grant cannot be distinguished
-- from one an owner added deliberately after the backfill, so this revokes both.
-- @data-loss

SET lock_timeout = '5s';
--> statement-breakpoint
DELETE FROM "role_permission_grants" g
USING "roles" r
WHERE r."id" = g."role_id"
  AND r."org_id" = g."org_id"
  AND r."is_system" = true
  AND r."slug" = 'CUSTOMER_SUPPORT'
  AND g."permission_key" IN (
    'support:tickets:view',
    'support:tickets:create',
    'support:tickets:reply',
    'support:reports:view',
    'support:knowledge-gaps:view',
    'support:csat:view'
  );
--> statement-breakpoint
UPDATE "access_versions" a
SET "permissions_version" = a."permissions_version" + 1, "updated_at" = now()
FROM (
  SELECT DISTINCT r."org_id" FROM "roles" r
  WHERE r."is_system" = true AND r."slug" = 'CUSTOMER_SUPPORT'
) o
WHERE a."org_id" = o."org_id";
