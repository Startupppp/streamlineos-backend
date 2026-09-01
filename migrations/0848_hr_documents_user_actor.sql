-- 0848: EXPAND documents with user_membership_id.
--
-- documents.service.ts reads applyScope(scope, orgId, userId, { ownerColumn: documents.userId })
-- at 8 callsites. This column is the DataScope ownerColumn for every document list and detail
-- read in HR — a revoked member stays visible in every query that uses 'own' or 'team' scope.
-- uploaded_by is already allowlisted as display-only; user_id IS authority.
--
-- Phase: EXPAND + BACKFILL + NOT VALID FK.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "documents" d
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = d.org_id
  AND om.user_id = d.user_id
  AND d."user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "fk_documents_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_documents_org_user_membership"
  ON "documents" ("org_id", "user_membership_id");
