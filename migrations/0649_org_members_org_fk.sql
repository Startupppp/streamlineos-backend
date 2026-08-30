SET lock_timeout = '5s';

-- `organization_members.org_id` is the join column from every member read, but the
-- migration chain never added the FK to `organizations(id)` — it existed in production
-- only because `drizzle push` applied the Drizzle model directly. Migration
-- `0370_tenant_column_integrity` (journal position 95) asserts that every tenant column
-- has a FK and aborts on a cold build when this one is absent.
--
-- This file must be journalled at journal array position 95
-- (after `0375_build_drop_dead_reports`, before `0370_tenant_column_integrity`),
-- with a `when` value strictly between those two entries.
--
-- Uses NOT VALID + VALIDATE so a live database avoids the full-table scan under
-- ACCESS EXCLUSIVE that a plain ADD CONSTRAINT takes.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organization_members_org_id_organizations_id_fk'
      AND conrelid = 'organization_members'::regclass
  ) THEN
    ALTER TABLE "organization_members"
      ADD CONSTRAINT "organization_members_org_id_organizations_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "organization_members"
  VALIDATE CONSTRAINT "organization_members_org_id_organizations_id_fk";
