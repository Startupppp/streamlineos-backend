SET statement_timeout = 0;
-- 0349 — Retire hr_locations and branches; repoint all consumers to org_units
-- ============================================================================
-- 0347_fk_repairs.sql explicitly deferred two conversions:
--   · users.branch_id          integer → text (FK → org_units)
--   · hr_employments.location_id  integer → text (FK → org_units)
-- Both are completed here.
--
-- DB is EMPTY for this deployment.  Backfill blocks are included for
-- populated environments and are idempotent (ON CONFLICT DO NOTHING;
-- IF NOT EXISTS guards on ADD COLUMN).
--
-- ON DELETE choices:
--   · location_id on hr_time_devices / hr_employments: SET NULL
--       A device or employment record is meaningful without its location; the
--       location being removed should not cascade-delete the employment.
--   · branch_id on users / client_accounts / incentive_config / incentives:
--       SET NULL  — the record survives; it just becomes unassigned.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 1: hr_locations → org_units (kind = 'LOCATION')
-- ─────────────────────────────────────────────────────────────────────────────

-- 1-A. Stamp each existing hr_locations row with a fresh UUID
ALTER TABLE hr_locations ADD COLUMN IF NOT EXISTS _new_id text;
--> statement-breakpoint
UPDATE hr_locations SET _new_id = gen_random_uuid()::text WHERE _new_id IS NULL;
--> statement-breakpoint

-- 1-B. Backfill org_units from hr_locations
--      code: prefer the stored code; fall back to first-6-alnum-chars + serial id
INSERT INTO org_units (id, org_id, kind, name, code, status, metadata, created_at, updated_at, deleted_at)
SELECT
  l._new_id,
  l.org_id,
  'LOCATION',
  l.name,
  COALESCE(
    NULLIF(TRIM(l.code), ''),
    SUBSTRING(REGEXP_REPLACE(UPPER(l.name), '[^A-Z0-9]', '', 'g'), 1, 6) || '_' || l.id::text
  ),
  CASE WHEN l.is_active THEN 'ACTIVE' ELSE 'DISABLED' END,
  jsonb_strip_nulls(jsonb_build_object(
    'locationType', COALESCE(l.type, 'OFFICE'),
    'address',      l.address->>'line1',
    'city',         l.address->>'city',
    'state',        l.address->>'state',
    'country',      l.address->>'country',
    'postalCode',   l.address->>'postalCode'
  )),
  l.created_at,
  l.updated_at,
  l.deleted_at
FROM hr_locations l
ON CONFLICT (org_id, kind, code) DO NOTHING;
--> statement-breakpoint

-- 1-C. hr_time_devices.location_id: drop old FK, convert integer → text, add FK → org_units
ALTER TABLE hr_time_devices
  DROP CONSTRAINT IF EXISTS hr_time_devices_location_id_hr_locations_id_fk;
--> statement-breakpoint

ALTER TABLE hr_time_devices ADD COLUMN location_id_new text;
--> statement-breakpoint

UPDATE hr_time_devices SET location_id_new = hr_locations._new_id
  FROM hr_locations WHERE hr_locations.id = hr_time_devices.location_id;
--> statement-breakpoint

ALTER TABLE hr_time_devices DROP COLUMN location_id;
--> statement-breakpoint

ALTER TABLE hr_time_devices RENAME COLUMN location_id_new TO location_id;
--> statement-breakpoint

ALTER TABLE hr_time_devices
  ADD CONSTRAINT fk_hr_time_devices_location
  FOREIGN KEY (location_id) REFERENCES org_units(id) ON DELETE SET NULL;
--> statement-breakpoint

-- 1-D. hr_employments.location_id: no FK existed; convert integer → text, add FK → org_units
ALTER TABLE hr_employments ADD COLUMN location_id_new text;
--> statement-breakpoint

UPDATE hr_employments SET location_id_new = hr_locations._new_id
  FROM hr_locations WHERE hr_locations.id = hr_employments.location_id;
--> statement-breakpoint

ALTER TABLE hr_employments DROP COLUMN location_id;
--> statement-breakpoint

ALTER TABLE hr_employments RENAME COLUMN location_id_new TO location_id;
--> statement-breakpoint

ALTER TABLE hr_employments
  ADD CONSTRAINT fk_hr_employments_location
  FOREIGN KEY (location_id) REFERENCES org_units(id) ON DELETE SET NULL;
--> statement-breakpoint

-- 1-E. Drop hr_locations; CASCADE removes indexes and the _new_id helper column
DROP TABLE IF EXISTS hr_locations CASCADE;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 2: branches → org_units (kind = 'BRANCH')
-- ─────────────────────────────────────────────────────────────────────────────
-- branch_manager_id → org_units.head_user_id  (identical semantic; existing column)
-- branch_hr_id      → org_units.metadata.hrContactUserId
--     Evidence: branch_hr_id is display-only in the old BranchesService
--     (loaded for rendering manager/HR names).  HR workflow routing uses
--     users.branch_id and users.role = 'HR', NOT branches.branch_hr_id.
--     Therefore metadata storage is sufficient; a real column is not needed.
--     Pending: owner of common/organization.ts must add
--       hrContactUserId?: string   to OrgUnitMetadata.
-- status ACTIVE → ACTIVE; INACTIVE → DISABLED

-- 2-A. Stamp each existing branches row with a fresh UUID
ALTER TABLE branches ADD COLUMN IF NOT EXISTS _new_id text;
--> statement-breakpoint
UPDATE branches SET _new_id = gen_random_uuid()::text WHERE _new_id IS NULL;
--> statement-breakpoint

-- 2-B. Backfill org_units from branches
INSERT INTO org_units (id, org_id, kind, name, code, status, head_user_id, metadata, created_at, updated_at)
SELECT
  b._new_id,
  b.org_id,
  'BRANCH',
  b.name,
  UPPER(b.code),
  CASE b.status WHEN 'ACTIVE' THEN 'ACTIVE' ELSE 'DISABLED' END,
  b.branch_manager_id,
  jsonb_strip_nulls(jsonb_build_object(
    'address',         b.address,
    'city',            b.city,
    'state',           b.state,
    'country',         b.country,
    'postalCode',      b.pincode,
    'phone',           b.phone,
    'email',           b.email,
    'hrContactUserId', b.branch_hr_id
  )),
  b.created_at,
  b.updated_at
FROM branches b
ON CONFLICT (org_id, kind, code) DO NOTHING;
--> statement-breakpoint

-- 2-C. users.branch_id: integer → text, FK → org_units
--      No FK existed at the DB level (Drizzle schema had no .references() due to
--      circular import: common/auth.ts ← common/organization.ts ← common/auth.ts).
ALTER TABLE users ADD COLUMN branch_id_new text;
--> statement-breakpoint

UPDATE users SET branch_id_new = branches._new_id
  FROM branches WHERE branches.id = users.branch_id;
--> statement-breakpoint

ALTER TABLE users DROP COLUMN branch_id;
--> statement-breakpoint

ALTER TABLE users RENAME COLUMN branch_id_new TO branch_id;
--> statement-breakpoint

ALTER TABLE users
  ADD CONSTRAINT fk_users_branch_id
  FOREIGN KEY (branch_id) REFERENCES org_units(id) ON DELETE SET NULL;
--> statement-breakpoint

-- 2-D. client_accounts.branch_id: integer FK → text FK → org_units
ALTER TABLE client_accounts
  DROP CONSTRAINT IF EXISTS client_accounts_branch_id_branches_id_fk;
--> statement-breakpoint

ALTER TABLE client_accounts ADD COLUMN branch_id_new text;
--> statement-breakpoint

UPDATE client_accounts SET branch_id_new = branches._new_id
  FROM branches WHERE branches.id = client_accounts.branch_id;
--> statement-breakpoint

ALTER TABLE client_accounts DROP COLUMN branch_id;
--> statement-breakpoint

ALTER TABLE client_accounts RENAME COLUMN branch_id_new TO branch_id;
--> statement-breakpoint

ALTER TABLE client_accounts
  ADD CONSTRAINT fk_client_accounts_branch_id
  FOREIGN KEY (branch_id) REFERENCES org_units(id) ON DELETE SET NULL;
--> statement-breakpoint

-- 2-E. incentive_config.branch_id: integer FK → text FK → org_units
ALTER TABLE incentive_config
  DROP CONSTRAINT IF EXISTS incentive_config_branch_id_branches_id_fk;
--> statement-breakpoint

ALTER TABLE incentive_config ADD COLUMN branch_id_new text;
--> statement-breakpoint

UPDATE incentive_config SET branch_id_new = branches._new_id
  FROM branches WHERE branches.id = incentive_config.branch_id;
--> statement-breakpoint

ALTER TABLE incentive_config DROP COLUMN branch_id;
--> statement-breakpoint

ALTER TABLE incentive_config RENAME COLUMN branch_id_new TO branch_id;
--> statement-breakpoint

ALTER TABLE incentive_config
  ADD CONSTRAINT fk_incentive_config_branch_id
  FOREIGN KEY (branch_id) REFERENCES org_units(id) ON DELETE SET NULL;
--> statement-breakpoint

-- 2-F. incentives.branch_id: integer FK → text FK → org_units
ALTER TABLE incentives
  DROP CONSTRAINT IF EXISTS incentives_branch_id_branches_id_fk;
--> statement-breakpoint

ALTER TABLE incentives ADD COLUMN branch_id_new text;
--> statement-breakpoint

UPDATE incentives SET branch_id_new = branches._new_id
  FROM branches WHERE branches.id = incentives.branch_id;
--> statement-breakpoint

ALTER TABLE incentives DROP COLUMN branch_id;
--> statement-breakpoint

ALTER TABLE incentives RENAME COLUMN branch_id_new TO branch_id;
--> statement-breakpoint

ALTER TABLE incentives
  ADD CONSTRAINT fk_incentives_branch_id
  FOREIGN KEY (branch_id) REFERENCES org_units(id) ON DELETE SET NULL;
--> statement-breakpoint

-- 2-G. Drop branches (CASCADE removes the _new_id column and any remaining FKs)
DROP TABLE IF EXISTS branches CASCADE;
--> statement-breakpoint

-- 2-H. Drop branch_status enum — no longer referenced by any column
DROP TYPE IF EXISTS branch_status;
