-- Migration 0230: CRM Customer 360 — contact roles, merge support, soft-delete
-- DO NOT apply manually; run via pnpm -C backend db:migrate

-- 1. Add merge/soft-delete columns to contacts
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS deleted_at timestamp,
  ADD COLUMN IF NOT EXISTS merged_into_id integer;

CREATE INDEX IF NOT EXISTS idx_contacts_deleted_at ON contacts (org_id) WHERE deleted_at IS NULL;

-- 2. Add merge/soft-delete columns to crm_organizations
ALTER TABLE crm_organizations
  ADD COLUMN IF NOT EXISTS deleted_at timestamp,
  ADD COLUMN IF NOT EXISTS merged_into_id integer;

CREATE INDEX IF NOT EXISTS idx_crm_organizations_deleted_at ON crm_organizations (org_id) WHERE deleted_at IS NULL;

-- 3. Create crm_contact_roles table
CREATE TABLE IF NOT EXISTS crm_contact_roles (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      text        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id  integer     NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  entity_type text        NOT NULL,
  entity_id   integer     NOT NULL,
  role_key    text        NOT NULL,
  is_primary  boolean     NOT NULL DEFAULT false,
  created_at  timestamp   NOT NULL DEFAULT now(),
  updated_at  timestamp   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_contact_roles_org ON crm_contact_roles (org_id);
CREATE INDEX IF NOT EXISTS idx_crm_contact_roles_contact ON crm_contact_roles (contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_contact_roles_entity ON crm_contact_roles (org_id, entity_type, entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_contact_roles_combo
  ON crm_contact_roles (org_id, contact_id, entity_type, entity_id, role_key);
