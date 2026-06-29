-- Add parentId (self-referential FK) and notes to crm_organizations
ALTER TABLE "crm_organizations"
  ADD COLUMN IF NOT EXISTS "parent_id" INTEGER REFERENCES "crm_organizations"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "notes" TEXT;

-- Composite index for hierarchy queries
CREATE INDEX IF NOT EXISTS "idx_crm_organizations_parent" ON "crm_organizations" ("org_id", "parent_id");
