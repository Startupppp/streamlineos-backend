-- ============================================================================
-- Wave 4 — tenant-composite foreign keys for the new bounded-context tables
-- ============================================================================
-- Scope (NEW tables only — never touches projects/organizations/organization_members/users):
--   directory:      workers, worker_engagements
--   party:          party_contacts, party_addresses
--   portal-access:  portal_memberships, portal_invitations, project_client_grants
--
-- WHY: these child tables currently reference their tenant parents with SINGLE-column
-- FKs (e.g. workers.organization_person_id -> organization_people.organization_person_id),
-- so nothing structurally prevents a child row in org A from pointing at a parent in org B.
-- This migration replaces them with tenant-composite (organization_id, parent_id) FKs
-- against the parent's UNIQUE(organization_id, id) candidate key — the DB can no longer
-- represent a cross-tenant parent/child relationship.
--
-- Postgres requires an FK target to be a UNIQUE CONSTRAINT (a plain UNIQUE INDEX is not
-- accepted). §A promotes the existing candidate-key unique INDEXES to unique CONSTRAINTS.
-- §B drops the single-column child FKs (name-agnostically) and adds the composite FKs.
--
-- IDEMPOTENT (guarded by pg_constraint / pg_class existence checks). Safe to re-run.
-- Apply on a Neon BRANCH first. Tables are empty today, so ADD CONSTRAINT validates instantly.
-- Matches the Drizzle schema (unique()/foreignKey() definitions) so a later db:generate sees no diff.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- §A. Promote parent candidate keys: UNIQUE INDEX -> UNIQUE CONSTRAINT (FK targets)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_org_people_org_person') THEN
    DROP INDEX IF EXISTS uniq_org_people_org_person;
    ALTER TABLE organization_people
      ADD CONSTRAINT uniq_org_people_org_person UNIQUE (organization_id, organization_person_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_workers_org_worker') THEN
    DROP INDEX IF EXISTS uniq_workers_org_worker;
    ALTER TABLE workers
      ADD CONSTRAINT uniq_workers_org_worker UNIQUE (organization_id, worker_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_business_parties_org_party') THEN
    DROP INDEX IF EXISTS uniq_business_parties_org_party;
    ALTER TABLE business_parties
      ADD CONSTRAINT uniq_business_parties_org_party UNIQUE (organization_id, party_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_party_contacts_org_contact') THEN
    DROP INDEX IF EXISTS uniq_party_contacts_org_contact;
    ALTER TABLE party_contacts
      ADD CONSTRAINT uniq_party_contacts_org_contact UNIQUE (organization_id, party_contact_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_portal_memberships_org_membership') THEN
    DROP INDEX IF EXISTS uniq_portal_memberships_org_membership;
    ALTER TABLE portal_memberships
      ADD CONSTRAINT uniq_portal_memberships_org_membership UNIQUE (organization_id, portal_membership_id);
  END IF;

  -- NEW 3-col candidate key: proves a client grant's party_contact matches its membership's bound contact.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_portal_memberships_org_membership_contact') THEN
    ALTER TABLE portal_memberships
      ADD CONSTRAINT uniq_portal_memberships_org_membership_contact
      UNIQUE (organization_id, portal_membership_id, party_contact_id);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- §B. Convert child FKs to tenant-composite. Each block drops any SINGLE-column FK on
-- the tenant-child column (name-agnostic) then adds the named composite FK.
-- ─────────────────────────────────────────────────────────────────────────────

-- helper note: single-col FKs are matched by array_length(conkey,1)=1 AND conkey[1]=attnum(col).

-- 1) workers.(organization_id, organization_person_id) -> organization_people
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE con.contype = 'f' AND rel.relname = 'workers'
      AND array_length(con.conkey, 1) = 1
      AND con.conkey[1] = (SELECT attnum FROM pg_attribute
                           WHERE attrelid = rel.oid AND attname = 'organization_person_id' AND NOT attisdropped)
  LOOP EXECUTE format('ALTER TABLE workers DROP CONSTRAINT %I', r.conname); END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workers_org_person') THEN
    ALTER TABLE workers ADD CONSTRAINT fk_workers_org_person
      FOREIGN KEY (organization_id, organization_person_id)
      REFERENCES organization_people (organization_id, organization_person_id) ON DELETE RESTRICT;
  END IF;
END $$;

-- 2) worker_engagements.(organization_id, worker_id) -> workers
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE con.contype = 'f' AND rel.relname = 'worker_engagements'
      AND array_length(con.conkey, 1) = 1
      AND con.conkey[1] = (SELECT attnum FROM pg_attribute
                           WHERE attrelid = rel.oid AND attname = 'worker_id' AND NOT attisdropped)
  LOOP EXECUTE format('ALTER TABLE worker_engagements DROP CONSTRAINT %I', r.conname); END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_worker_engagements_org_worker') THEN
    ALTER TABLE worker_engagements ADD CONSTRAINT fk_worker_engagements_org_worker
      FOREIGN KEY (organization_id, worker_id)
      REFERENCES workers (organization_id, worker_id) ON DELETE CASCADE;
  END IF;
END $$;

-- 3) party_contacts.(organization_id, party_id) -> business_parties
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE con.contype = 'f' AND rel.relname = 'party_contacts'
      AND array_length(con.conkey, 1) = 1
      AND con.conkey[1] = (SELECT attnum FROM pg_attribute
                           WHERE attrelid = rel.oid AND attname = 'party_id' AND NOT attisdropped)
  LOOP EXECUTE format('ALTER TABLE party_contacts DROP CONSTRAINT %I', r.conname); END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_party_contacts_org_party') THEN
    ALTER TABLE party_contacts ADD CONSTRAINT fk_party_contacts_org_party
      FOREIGN KEY (organization_id, party_id)
      REFERENCES business_parties (organization_id, party_id) ON DELETE CASCADE;
  END IF;
END $$;

-- 4) party_addresses.(organization_id, party_id) -> business_parties
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE con.contype = 'f' AND rel.relname = 'party_addresses'
      AND array_length(con.conkey, 1) = 1
      AND con.conkey[1] = (SELECT attnum FROM pg_attribute
                           WHERE attrelid = rel.oid AND attname = 'party_id' AND NOT attisdropped)
  LOOP EXECUTE format('ALTER TABLE party_addresses DROP CONSTRAINT %I', r.conname); END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_party_addresses_org_party') THEN
    ALTER TABLE party_addresses ADD CONSTRAINT fk_party_addresses_org_party
      FOREIGN KEY (organization_id, party_id)
      REFERENCES business_parties (organization_id, party_id) ON DELETE CASCADE;
  END IF;
END $$;

-- 5) portal_memberships.(organization_id, party_contact_id) -> party_contacts  (was a bare column, no FK)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_portal_memberships_org_contact') THEN
    ALTER TABLE portal_memberships ADD CONSTRAINT fk_portal_memberships_org_contact
      FOREIGN KEY (organization_id, party_contact_id)
      REFERENCES party_contacts (organization_id, party_contact_id) ON DELETE RESTRICT;
  END IF;
END $$;

-- 6) portal_invitations: drop single-col FK on accepted_portal_membership_id -> composite; add contact FK
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE con.contype = 'f' AND rel.relname = 'portal_invitations'
      AND array_length(con.conkey, 1) = 1
      AND con.conkey[1] = (SELECT attnum FROM pg_attribute
                           WHERE attrelid = rel.oid AND attname = 'accepted_portal_membership_id' AND NOT attisdropped)
  LOOP EXECUTE format('ALTER TABLE portal_invitations DROP CONSTRAINT %I', r.conname); END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_portal_invitations_org_accepted_membership') THEN
    ALTER TABLE portal_invitations ADD CONSTRAINT fk_portal_invitations_org_accepted_membership
      FOREIGN KEY (organization_id, accepted_portal_membership_id)
      REFERENCES portal_memberships (organization_id, portal_membership_id) ON DELETE NO ACTION;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_portal_invitations_org_contact') THEN
    ALTER TABLE portal_invitations ADD CONSTRAINT fk_portal_invitations_org_contact
      FOREIGN KEY (organization_id, party_contact_id)
      REFERENCES party_contacts (organization_id, party_contact_id) ON DELETE RESTRICT;
  END IF;
END $$;

-- 7) project_client_grants: drop single-col FK on portal_membership_id -> 3-col composite; add contact FK
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE con.contype = 'f' AND rel.relname = 'project_client_grants'
      AND array_length(con.conkey, 1) = 1
      AND con.conkey[1] = (SELECT attnum FROM pg_attribute
                           WHERE attrelid = rel.oid AND attname = 'portal_membership_id' AND NOT attisdropped)
  LOOP EXECUTE format('ALTER TABLE project_client_grants DROP CONSTRAINT %I', r.conname); END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_client_grants_org_membership_contact') THEN
    ALTER TABLE project_client_grants ADD CONSTRAINT fk_project_client_grants_org_membership_contact
      FOREIGN KEY (organization_id, portal_membership_id, party_contact_id)
      REFERENCES portal_memberships (organization_id, portal_membership_id, party_contact_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_client_grants_org_contact') THEN
    ALTER TABLE project_client_grants ADD CONSTRAINT fk_project_client_grants_org_contact
      FOREIGN KEY (organization_id, party_contact_id)
      REFERENCES party_contacts (organization_id, party_contact_id) ON DELETE RESTRICT;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- §C. VERIFY (read-only). Every composite FK below must return 't'.
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT conname, array_length(conkey,1) AS cols
-- FROM pg_constraint
-- WHERE conname IN (
--   'fk_workers_org_person','fk_worker_engagements_org_worker',
--   'fk_party_contacts_org_party','fk_party_addresses_org_party',
--   'fk_portal_memberships_org_contact','fk_portal_invitations_org_accepted_membership',
--   'fk_portal_invitations_org_contact','fk_project_client_grants_org_membership_contact',
--   'fk_project_client_grants_org_contact'
-- ) ORDER BY conname;
-- Expect 9 rows; the 3-col grant FK has cols=3, the rest cols=2.

-- ============================================================================
-- Deferred (needs branch-quiet, touches concurrent-session `projects`):
--   project_client_grants.(organization_id, project_id) -> projects(organization_id, id)
--   projects.(organization_id, managed_product_id) -> managed_products(org_id, managed_product_id)
-- These require adding UNIQUE(org_id, id) candidate keys to `projects`/`managed_products`,
-- which the concurrent Projects session also edits — do them in the Wave-4 projects pass.
-- ============================================================================
