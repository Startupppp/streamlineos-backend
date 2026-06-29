-- RBAC Slice 1: additive access tables — multi-role assignment (user_roles), per-grant data scope
-- (role_permission_grants), department group roles (group_roles), and versioned cache invalidation
-- (access_versions). Forward-only and idempotent. Non-breaking: the legacy users.role /
-- roles.permissions jsonb / role_permissions / user_permissions / CASL model is untouched.

-- 1. Enums. CREATE TYPE has no IF NOT EXISTS, so guard against re-runs.
DO $$ BEGIN
  CREATE TYPE "data_scope" AS ENUM ('all', 'team', 'own', 'none');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "principal_group_type" AS ENUM ('department');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 2. Multi-role assignment: a user holds many roles in an org.
CREATE TABLE IF NOT EXISTS user_roles (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMP,
  reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
-- Add columns that may be missing on existing deployments (idempotent)
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS reason TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_roles_org_user_role ON user_roles(org_id, user_id, role_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_org_user ON user_roles(org_id, user_id);

-- 3. Normalized role → permission grants, each with a per-row data scope.
CREATE TABLE IF NOT EXISTS role_permission_grants (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(name) ON DELETE CASCADE,
  scope "data_scope" NOT NULL DEFAULT 'all',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_role_permission_grants_role_key ON role_permission_grants(role_id, permission_key);
CREATE INDEX IF NOT EXISTS idx_role_permission_grants_org_role ON role_permission_grants(org_id, role_id);

-- 4. Group roles: a role granted to every member of a group (departments for now).
CREATE TABLE IF NOT EXISTS group_roles (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  group_type "principal_group_type" NOT NULL,
  group_id INTEGER NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_group_roles_org_group_role ON group_roles(org_id, group_type, group_id, role_id);
CREATE INDEX IF NOT EXISTS idx_group_roles_org_group ON group_roles(org_id, group_type, group_id);

-- 5. Per-org permissions version. Bumped in-transaction on any role/grant/assignment mutation;
--    the resolver cache key embeds the version, so a bump busts the org's cache atomically.
CREATE TABLE IF NOT EXISTS access_versions (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  permissions_version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 6. Generic resource-scoped grants: a principal (user or role) holds a named permission on a
--    specific resource instance (e.g., "user X may manage KB space Z"). Keyed by UUID so the
--    revoke path receives an opaque grant id with no sequential enumeration risk.
CREATE TABLE IF NOT EXISTS resource_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id VARCHAR(36) NOT NULL,
  resource_type VARCHAR(64) NOT NULL,
  resource_id VARCHAR(36) NOT NULL,
  principal_type VARCHAR(16) NOT NULL DEFAULT 'user' CHECK (principal_type IN ('user', 'role')),
  principal_id VARCHAR(36) NOT NULL,
  permission_key VARCHAR(128) NOT NULL,
  granted_by VARCHAR(36),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS resource_grants_unique_idx ON resource_grants(org_id, resource_type, resource_id, principal_type, principal_id, permission_key);
CREATE INDEX IF NOT EXISTS resource_grants_org_resource_idx ON resource_grants(org_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS resource_grants_principal_idx ON resource_grants(org_id, principal_type, principal_id);
