SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 0391 — org-scoped member lifecycle source of truth.
--
-- Users suspend/archive previously flipped global users.is_active / user_status
-- and mapped both suspended and archived onto organization_members.status =
-- SUSPENDED. That blasted multi-org members out of every tenant. Going forward,
-- ACTIVE / SUSPENDED / LEFT (archived) on organization_members is authoritative
-- for the acting org. This backfill:
--   1) moves legacy archived rows from SUSPENDED → LEFT
--   2) restores global users flags when the account still has an active
--      membership somewhere (so other orgs are not permanently locked out)

UPDATE organization_members AS om
SET
  status = 'LEFT',
  left_at = COALESCE(u.archived_at, NOW()),
  suspended_at = NULL
FROM users AS u
WHERE om.user_id = u.id
  AND u.user_status = 'archived'
  AND om.status = 'SUSPENDED';
--> statement-breakpoint

UPDATE users AS u
SET
  is_active = true,
  user_status = 'active',
  archived_at = NULL
WHERE u.deleted_at IS NULL
  AND u.user_status <> 'deleted'
  AND (u.is_active = false OR u.user_status IN ('suspended', 'archived'))
  AND EXISTS (
    SELECT 1
    FROM organization_members AS om
    WHERE om.user_id = u.id
      AND om.status IN ('ACTIVE', 'INVITED')
  );
