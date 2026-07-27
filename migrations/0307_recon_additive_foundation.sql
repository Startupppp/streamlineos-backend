-- ============================================================================
-- Additive schema migration — all NEW tables/enums/columns staged this engagement
-- ============================================================================
-- Covers: managed_products (+ projects.managed_product_id), directory
-- (organization_people, workers, worker_engagements), party (business_parties,
-- party_contacts, party_addresses), portal-access (portal_memberships,
-- portal_invitations, project_client_grants).
--
-- Purely ADDITIVE + IDEMPOTENT (CREATE ... IF NOT EXISTS, guarded enums/FK). Safe to
-- apply on the drifted DB WITHOUT the full journal reconciliation, so the staged
-- backend modules (directory, managed-products) become runnable. It matches the
-- Drizzle schema exactly, so a later `db:generate` sees no diff for these objects.
-- Text PKs have NO DB default (the app sets the UUID via $defaultFn); serial PKs keep
-- their sequence. Apply on a Neon BRANCH first.
--
-- Run the Wave 1 ownership migration (wave-1-ownership-migration.sql) separately.
-- ============================================================================

-- §1. Enums (idempotent) ------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='managed_product_status') THEN
    CREATE TYPE managed_product_status AS ENUM ('active','archived'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='worker_engagement_status') THEN
    CREATE TYPE worker_engagement_status AS ENUM ('PLANNED','ACTIVE','COMPLETED','TERMINATED','CANCELLED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='party_type') THEN
    CREATE TYPE party_type AS ENUM ('CUSTOMER','VENDOR','PARTNER','BOTH'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='portal_audience') THEN
    CREATE TYPE portal_audience AS ENUM ('CLIENT_PORTAL'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='portal_membership_status') THEN
    CREATE TYPE portal_membership_status AS ENUM ('PENDING','ACTIVE','SUSPENDED','REVOKED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='portal_invitation_status') THEN
    CREATE TYPE portal_invitation_status AS ENUM ('PENDING','ACCEPTED','REVOKED','EXPIRED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='portal_grant_status') THEN
    CREATE TYPE portal_grant_status AS ENUM ('ACTIVE','SUSPENDED','REVOKED','EXPIRED'); END IF;
END $$;

-- §2. Managed Products (org_id) ----------------------------------------------
CREATE TABLE IF NOT EXISTS managed_products (
  managed_product_id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  key text NOT NULL,
  description text,
  status managed_product_status NOT NULL DEFAULT 'active',
  owner_id text REFERENCES users(id) ON DELETE SET NULL,
  deleted_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_managed_products_org_key ON managed_products (org_id, key);
CREATE INDEX IF NOT EXISTS idx_managed_products_org_status ON managed_products (org_id, status);

-- projects.managed_product_id link (additive column + FK, guarded)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS managed_product_id integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_projects_managed_product') THEN
    ALTER TABLE projects ADD CONSTRAINT fk_projects_managed_product
      FOREIGN KEY (managed_product_id) REFERENCES managed_products(managed_product_id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_projects_managed_product ON projects (managed_product_id);

-- §3. Directory (organization_id) --------------------------------------------
CREATE TABLE IF NOT EXISTS organization_people (
  organization_person_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  organization_membership_id integer REFERENCES organization_members(id) ON DELETE SET NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  display_name text,
  preferred_name text,
  work_email text,
  personal_email text,
  phone text,
  whatsapp_number text,
  avatar_url text,
  date_of_birth date,
  gender text,
  nationality text,
  timezone text,
  language_code text DEFAULT 'en',
  address jsonb,
  emergency_contact jsonb,
  linkedin_url text,
  github_url text,
  bio text,
  deleted_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_people_org_person ON organization_people (organization_id, organization_person_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_people_org_user ON organization_people (organization_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_people_org_membership ON organization_people (organization_id, organization_membership_id) WHERE organization_membership_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_people_org_work_email ON organization_people (organization_id, work_email) WHERE work_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_org_people_org ON organization_people (organization_id);
CREATE INDEX IF NOT EXISTS idx_org_people_user ON organization_people (user_id);
CREATE INDEX IF NOT EXISTS idx_org_people_membership ON organization_people (organization_membership_id);

CREATE TABLE IF NOT EXISTS workers (
  worker_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  organization_person_id text NOT NULL REFERENCES organization_people(organization_person_id) ON DELETE RESTRICT,
  worker_number text,
  status text NOT NULL DEFAULT 'INACTIVE',
  is_payee boolean NOT NULL DEFAULT false,
  deleted_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_workers_org_worker ON workers (organization_id, worker_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_workers_org_person ON workers (organization_id, organization_person_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_workers_org_number ON workers (organization_id, worker_number) WHERE worker_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workers_org ON workers (organization_id);
CREATE INDEX IF NOT EXISTS idx_workers_person ON workers (organization_person_id);
CREATE INDEX IF NOT EXISTS idx_workers_org_status ON workers (organization_id, status);

CREATE TABLE IF NOT EXISTS worker_engagements (
  worker_engagement_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  worker_id text NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
  starts_on date NOT NULL,
  ends_on date,
  worker_type text NOT NULL,
  status worker_engagement_status NOT NULL DEFAULT 'PLANNED',
  is_primary boolean NOT NULL DEFAULT false,
  department_id text,
  business_unit_id text,
  branch_id text,
  location_id text,
  team_id text,
  manager_engagement_id text,
  designation text,
  job_role_id integer,
  job_level_id integer,
  employment_type_id integer,
  probation_ends_on date,
  notice_period_days integer,
  termination_reason text,
  termination_notes text,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_worker_engagements_org_engagement ON worker_engagements (organization_id, worker_engagement_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_worker_engagements_active_primary ON worker_engagements (organization_id, worker_id) WHERE is_primary = true AND status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_worker_engagements_org ON worker_engagements (organization_id);
CREATE INDEX IF NOT EXISTS idx_worker_engagements_worker ON worker_engagements (worker_id);
CREATE INDEX IF NOT EXISTS idx_worker_engagements_org_status ON worker_engagements (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_worker_engagements_org_starts ON worker_engagements (organization_id, starts_on);
CREATE INDEX IF NOT EXISTS idx_worker_engagements_manager ON worker_engagements (manager_engagement_id);

-- §4. Business Party (organization_id) ---------------------------------------
CREATE TABLE IF NOT EXISTS business_parties (
  party_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  party_type party_type NOT NULL DEFAULT 'CUSTOMER',
  name text NOT NULL,
  legal_name text,
  display_name text,
  tax_number text,
  website text,
  email text,
  phone text,
  status text NOT NULL DEFAULT 'active',
  notes text,
  deleted_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_business_parties_org_party ON business_parties (organization_id, party_id);
CREATE INDEX IF NOT EXISTS idx_business_parties_org_type ON business_parties (organization_id, party_type);

CREATE TABLE IF NOT EXISTS party_contacts (
  party_contact_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  party_id text NOT NULL REFERENCES business_parties(party_id) ON DELETE CASCADE,
  first_name text NOT NULL,
  last_name text,
  email text,
  phone text,
  title text,
  is_primary boolean NOT NULL DEFAULT false,
  deleted_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_party_contacts_org_contact ON party_contacts (organization_id, party_contact_id);
CREATE INDEX IF NOT EXISTS idx_party_contacts_org_party ON party_contacts (organization_id, party_id);

CREATE TABLE IF NOT EXISTS party_addresses (
  party_address_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  party_id text NOT NULL REFERENCES business_parties(party_id) ON DELETE CASCADE,
  address_type text NOT NULL,
  line1 text NOT NULL,
  line2 text,
  city text,
  state text,
  country text,
  postal_code text,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_party_addresses_org_party ON party_addresses (organization_id, party_id);

-- §5. Portal access (organization_id) ----------------------------------------
CREATE TABLE IF NOT EXISTS portal_memberships (
  portal_membership_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  audience portal_audience NOT NULL DEFAULT 'CLIENT_PORTAL',
  party_contact_id text NOT NULL,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  status portal_membership_status NOT NULL DEFAULT 'PENDING',
  session_epoch integer NOT NULL DEFAULT 0,
  deleted_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_portal_memberships_org_membership ON portal_memberships (organization_id, portal_membership_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_portal_memberships_org_contact_audience ON portal_memberships (organization_id, party_contact_id, audience) WHERE status <> 'REVOKED';
CREATE INDEX IF NOT EXISTS idx_portal_memberships_org_status ON portal_memberships (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_portal_memberships_user ON portal_memberships (user_id);

CREATE TABLE IF NOT EXISTS portal_invitations (
  portal_invitation_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  party_contact_id text NOT NULL,
  audience portal_audience NOT NULL DEFAULT 'CLIENT_PORTAL',
  email text NOT NULL,
  token_hash text NOT NULL,
  status portal_invitation_status NOT NULL DEFAULT 'PENDING',
  inviter_membership_id integer REFERENCES organization_members(id) ON DELETE SET NULL,
  accepted_portal_membership_id text REFERENCES portal_memberships(portal_membership_id) ON DELETE SET NULL,
  expires_at timestamp NOT NULL,
  revoked_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_portal_invitations_org_invitation ON portal_invitations (organization_id, portal_invitation_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_portal_invitations_org_email_audience_pending ON portal_invitations (organization_id, email, audience) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_portal_invitations_org_status ON portal_invitations (organization_id, status);

CREATE TABLE IF NOT EXISTS project_client_grants (
  project_client_grant_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  portal_membership_id text NOT NULL REFERENCES portal_memberships(portal_membership_id) ON DELETE CASCADE,
  party_contact_id text NOT NULL,
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pm_workspace_id text,
  can_view_milestones boolean NOT NULL DEFAULT false,
  can_view_tasks boolean NOT NULL DEFAULT false,
  can_view_attachments boolean NOT NULL DEFAULT false,
  can_view_comments boolean NOT NULL DEFAULT false,
  can_submit_change_requests boolean NOT NULL DEFAULT false,
  status portal_grant_status NOT NULL DEFAULT 'ACTIVE',
  expires_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_client_grants_org_grant ON project_client_grants (organization_id, project_client_grant_id);
CREATE INDEX IF NOT EXISTS idx_project_client_grants_membership ON project_client_grants (organization_id, portal_membership_id);
CREATE INDEX IF NOT EXISTS idx_project_client_grants_project ON project_client_grants (organization_id, project_id);

-- ============================================================================
-- After applying (Neon branch first): the directory + managed-products backend
-- modules become runnable. The tenant-composite FKs (org_id, parent_id) and the
-- portal party-contact composite FK are added in Wave 4/7 per the composite-FK matrix.
-- ============================================================================
