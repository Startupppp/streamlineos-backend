-- Wave 1 §C — lock in the owner pointer (run AFTER §VERIFY passed: 0 orphan / 0 multi-owner).
-- Applies the deferred composite FK + owner-lifecycle guard trigger. Idempotent.
-- NOT NULL is intentionally NOT applied here: it requires createOrganization to preallocate the
-- membership id (plan §4). owner_membership_id stays nullable until that code change ships.

-- 1. Promote the (org_id, id) unique index to a constraint so the composite FK can target it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_org_members_org_id_key')
     AND EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uniq_org_members_org_id' AND relkind = 'i') THEN
    ALTER TABLE organization_members
      ADD CONSTRAINT uniq_org_members_org_id_key UNIQUE USING INDEX uniq_org_members_org_id;
  END IF;
END $$;

-- 2. Deferred composite FK: owner pointer must reference a real membership in the same org.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_organizations_owner_membership') THEN
    ALTER TABLE organizations
      ADD CONSTRAINT fk_organizations_owner_membership
      FOREIGN KEY (id, owner_membership_id)
      REFERENCES organization_members (org_id, id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- 3. Owner-lifecycle guard: block suspend/leave/delete of the CURRENT owner membership.
--    (When an org itself is deleted, the org row is gone first, so ptr is NULL and cascade is allowed.)
CREATE OR REPLACE FUNCTION guard_owner_membership() RETURNS trigger AS $guard$
DECLARE ptr integer;
BEGIN
  SELECT owner_membership_id INTO ptr FROM organizations WHERE id = OLD.org_id;
  IF ptr IS NOT NULL AND ptr = OLD.id THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cannot delete the owner membership (org %). Transfer ownership first.', OLD.org_id;
    ELSIF NEW.status IN ('SUSPENDED', 'LEFT') THEN
      RAISE EXCEPTION 'Cannot set the owner membership to % (org %). Transfer ownership first.', NEW.status, OLD.org_id;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_owner_membership ON organization_members;
CREATE TRIGGER trg_guard_owner_membership
  BEFORE UPDATE OR DELETE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION guard_owner_membership();
