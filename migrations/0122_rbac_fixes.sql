-- RBAC fix: extend principal_group_type enum, widen unique index on role_permission_grants,
-- and add missing columns (expires_at, reason) to user_roles.
-- Forward-only and idempotent where possible.

-- 1. Add missing enum values to principal_group_type (ALTER TYPE … ADD VALUE is safe to run
--    even when already present on Postgres 14+; use DO block for idempotency on older versions).
DO $$ BEGIN
  ALTER TYPE "principal_group_type" ADD VALUE IF NOT EXISTS 'team';
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TYPE "principal_group_type" ADD VALUE IF NOT EXISTS 'custom';
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 2. Widen the unique index on role_permission_grants to include org_id.
--    Drop the old narrow index first, then recreate with the correct columns.
DROP INDEX IF EXISTS uniq_role_permission_grants_role_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_role_permission_grants_role_key
  ON role_permission_grants(org_id, role_id, permission_key);

-- 3. Add expires_at and reason to user_roles (nullable — safe additive columns).
ALTER TABLE user_roles
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS reason TEXT;
