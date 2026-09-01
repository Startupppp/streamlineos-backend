-- 0853: EXPAND fin_approval_policies, journal_entries and affiliates with membership_id columns.
--
-- fin_approval_policies.approver_user_id is used in finance-posting.service.ts to route
-- approval notifications to the approver. Moving to approver_membership_id ensures that
-- a revoked member no longer receives approvals for which they are no longer active.
--
-- journal_entries.created_by is the ownerColumn for DataScope in accounting-ledger.service.ts.
-- Entries are immutable once posted, so the historical created_by is preserved; the new
-- created_by_membership_id carries live authority for the DataScope `own` filter.
--
-- affiliates.user_id is used in WHERE predicates inside affiliate.service.ts for ownership
-- checks (eq(affiliates.userId, userId) in register and getDashboard). Moving to
-- user_membership_id makes revocation actually revoke.
--
-- Phase: EXPAND + BACKFILL + NOT VALID FK.
-- Legacy columns are NOT dropped here.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "fin_approval_policies" ADD COLUMN IF NOT EXISTS "approver_membership_id" integer;

--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "created_by_membership_id" integer;

--> statement-breakpoint
ALTER TABLE "affiliates" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "fin_approval_policies" fap
SET "approver_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = fap.org_id
  AND om.user_id = fap.approver_user_id
  AND fap.approver_user_id IS NOT NULL
  AND fap."approver_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "journal_entries" je
SET "created_by_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = je.org_id
  AND om.user_id = je.created_by
  AND je."created_by_membership_id" IS NULL;

--> statement-breakpoint
-- No affiliates backfill, and this is deliberate. `affiliates.user_id` is an INTEGER with no
-- foreign key, while `organization_members.user_id` is TEXT like every other user reference in
-- the schema, so `om.user_id = a.user_id` fails outright with `operator does not exist:
-- text = integer`. A cold replay caught it; production has never run this file. The table holds
-- zero rows, so there is nothing to backfill and a cast would only paper over the type defect.
-- `affiliates.user_id` being an unconstrained integer is a separate schema bug and is recorded
-- as such; the column added above stays NULL until it is resolved.

--> statement-breakpoint
ALTER TABLE "fin_approval_policies"
  ADD CONSTRAINT "fk_fin_approval_policies_org_mbr"
  FOREIGN KEY ("org_id", "approver_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("approver_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "journal_entries"
  ADD CONSTRAINT "fk_je_org_created_by_mbr"
  FOREIGN KEY ("org_id", "created_by_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("created_by_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "affiliates"
  ADD CONSTRAINT "fk_affiliates_org_user_mbr"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fin_approval_policies_org_mbr"
  ON "fin_approval_policies" ("org_id", "approver_membership_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_je_org_created_by_mbr"
  ON "journal_entries" ("org_id", "created_by_membership_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "affiliates_org_mbr_idx"
  ON "affiliates" ("org_id", "user_membership_id");
