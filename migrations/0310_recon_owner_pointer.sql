-- ============================================================================
-- Wave 1 — Ownership + membership lifecycle migration
-- ============================================================================
-- Self-contained and IDEMPOTENT: safe to run more than once, and safe whether or
-- not `pnpm -C backend db:generate` has already added the additive columns
-- (every DDL step uses IF NOT EXISTS). The owner bootstrap (§B) and the deferred
-- FK/lifecycle guard (§C) are custom DATA/constraint steps drizzle-kit cannot
-- generate — they are the real deliverable here.
--
-- HOW TO APPLY (code-only session; you run it):
--   1. On a Neon BRANCH first (never prod first).
--   2. Run §A + §B in one shot:  psql "$DATABASE_URL" -f docs/schema-migration/wave-1-ownership-migration.sql
--      (or: node backend/scripts/apply-sql-file.mjs ../docs/... adapted, or paste into Neon SQL editor)
--   3. Run the §VERIFY query. It must return ZERO rows (except genuinely member-less orgs).
--   4. Only after zero unresolved: uncomment and run §C (deferred FK + NOT NULL + trigger).
--   5. Repeat on prod after the branch passes.
--
-- Depends on: organization_members.id (serial PK) already has UNIQUE(org_id, id)
--   (present in the inspected schema — the composite-FK anchor).
-- ============================================================================


-- §A. Additive schema (idempotent) --------------------------------------------

-- membership_status enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'membership_status') THEN
    CREATE TYPE membership_status AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'LEFT');
  END IF;
END $$;

-- organization_members lifecycle columns
ALTER TABLE organization_members
  ADD COLUMN IF NOT EXISTS status        membership_status NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS invited_at    timestamp,
  ADD COLUMN IF NOT EXISTS activated_at  timestamp,
  ADD COLUMN IF NOT EXISTS suspended_at  timestamp,
  ADD COLUMN IF NOT EXISTS left_at       timestamp;

-- organizations owner pointer
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS owner_membership_id integer;

-- indexes / candidate key (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_members_org_id
  ON organization_members (org_id, id);
CREATE INDEX IF NOT EXISTS idx_org_members_org_status
  ON organization_members (org_id, status);

-- backfill lifecycle timestamps for existing active members
UPDATE organization_members
  SET activated_at = COALESCE(activated_at, joined_at)
  WHERE status = 'ACTIVE' AND activated_at IS NULL;


-- §B. Owner-pointer bootstrap (idempotent, row-locked, deterministic) ----------
-- For every organization: choose the canonical owner membership, set the pointer,
-- normalize is_owner (exactly one true), and leave a NOTICE for any repaired
-- ambiguous/ownerless org. Member-less orgs are left NULL and WARNed (quarantine).
DO $$
DECLARE
  org         RECORD;
  chosen_id   integer;
  owner_count integer;
BEGIN
  FOR org IN SELECT id FROM organizations ORDER BY id LOOP
    -- lock the org and its memberships for the duration of this iteration
    PERFORM 1 FROM organizations WHERE id = org.id FOR UPDATE;
    PERFORM 1 FROM organization_members WHERE org_id = org.id FOR UPDATE;

    SELECT count(*) INTO owner_count
      FROM organization_members
      WHERE org_id = org.id AND is_owner = true;

    IF owner_count = 1 THEN
      SELECT id INTO chosen_id
        FROM organization_members
        WHERE org_id = org.id AND is_owner = true
        LIMIT 1;
    ELSIF owner_count > 1 THEN
      -- ambiguous: deterministic pick = active first, then earliest joined, then lowest id
      SELECT id INTO chosen_id
        FROM organization_members
        WHERE org_id = org.id AND is_owner = true
        ORDER BY (status = 'ACTIVE') DESC, joined_at ASC, id ASC
        LIMIT 1;
      RAISE NOTICE 'REPAIR org %: % owners collapsed to membership %', org.id, owner_count, chosen_id;
    ELSE
      -- ownerless: elect the earliest active member (creator proxy), else earliest member
      SELECT id INTO chosen_id
        FROM organization_members
        WHERE org_id = org.id
        ORDER BY (status = 'ACTIVE') DESC, joined_at ASC, id ASC
        LIMIT 1;
      IF chosen_id IS NOT NULL THEN
        RAISE NOTICE 'REPAIR org %: no owner, elected membership %', org.id, chosen_id;
      END IF;
    END IF;

    IF chosen_id IS NOT NULL THEN
      UPDATE organizations
        SET owner_membership_id = chosen_id
        WHERE id = org.id;
      UPDATE organization_members
        SET is_owner = true, status = 'ACTIVE',
            activated_at = COALESCE(activated_at, joined_at)
        WHERE id = chosen_id;
      UPDATE organization_members
        SET is_owner = false
        WHERE org_id = org.id AND id <> chosen_id AND is_owner = true;
    ELSE
      RAISE WARNING 'QUARANTINE org %: zero memberships; owner_membership_id left NULL', org.id;
    END IF;
  END LOOP;
END $$;


-- §VERIFY. Must return ZERO rows before running §C (except truly member-less orgs). ---
--   SELECT o.id
--   FROM organizations o
--   LEFT JOIN organization_members m ON m.org_id = o.id
--   WHERE o.owner_membership_id IS NULL
--   GROUP BY o.id
--   HAVING count(m.id) > 0;   -- orgs that HAVE members but still no owner = a bug to fix
--
--   -- also sanity: exactly one is_owner per org
--   SELECT org_id, count(*) FROM organization_members
--   WHERE is_owner = true GROUP BY org_id HAVING count(*) <> 1;


-- §C. FINAL LOCK-IN (run ONLY after §VERIFY returns zero) ----------------------
-- Deferred composite FK: proves the owner pointer references a real membership in
-- the SAME organization. Then make the pointer NOT NULL.
--
-- ALTER TABLE organizations
--   ADD CONSTRAINT fk_organizations_owner_membership
--   FOREIGN KEY (id, owner_membership_id)
--   REFERENCES organization_members (org_id, id)
--   DEFERRABLE INITIALLY DEFERRED;
--
-- ALTER TABLE organizations
--   ALTER COLUMN owner_membership_id SET NOT NULL;   -- only if NO member-less orgs remain
--
-- Lifecycle guard: block suspending/leaving/deleting the owner membership before transfer.
-- CREATE OR REPLACE FUNCTION guard_owner_membership() RETURNS trigger AS $guard$
-- DECLARE ptr integer;
-- BEGIN
--   SELECT owner_membership_id INTO ptr FROM organizations WHERE id = OLD.org_id;
--   IF ptr = OLD.id THEN
--     IF TG_OP = 'DELETE' THEN
--       RAISE EXCEPTION 'Cannot delete the owner membership (org %). Transfer ownership first.', OLD.org_id;
--     ELSIF NEW.status IN ('SUSPENDED','LEFT') THEN
--       RAISE EXCEPTION 'Cannot % the owner membership (org %). Transfer ownership first.', NEW.status, OLD.org_id;
--     END IF;
--   END IF;
--   RETURN NEW;
-- END;
-- $guard$ LANGUAGE plpgsql;
--
-- DROP TRIGGER IF EXISTS trg_guard_owner_membership ON organization_members;
-- CREATE TRIGGER trg_guard_owner_membership
--   BEFORE UPDATE OR DELETE ON organization_members
--   FOR EACH ROW EXECUTE FUNCTION guard_owner_membership();
--
-- After §C: the backend derives owner from organizations.owner_membership_id
-- (organization.service.transferOwnership already sets/reads the pointer);
-- `is_owner` remains a synced mirror until a later contract release drops it.
-- ============================================================================
