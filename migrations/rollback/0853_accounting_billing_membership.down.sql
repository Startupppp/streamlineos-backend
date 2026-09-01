-- Rollback 0853: drop the fin_approval_policies, journal_entries, and affiliates
-- membership-id columns.
--
-- @data-loss — the backfilled approver_membership_id, created_by_membership_id, and
-- user_membership_id pointers are discarded. This is acceptable: the legacy
-- approver_user_id, created_by, and user_id columns are still present and still
-- populated, so all three tables return to a working state.
--
-- Roll the code back first. Services that have been cut over to dual-read the membership
-- columns will fail 42703 on the next read if the columns are dropped under a running
-- deployment.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "fin_approval_policies" DROP CONSTRAINT IF EXISTS "fk_fin_approval_policies_org_mbr";

--> statement-breakpoint
ALTER TABLE "fin_approval_policies" DROP COLUMN IF EXISTS "approver_membership_id";

--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT IF EXISTS "fk_je_org_created_by_mbr";

--> statement-breakpoint
ALTER TABLE "journal_entries" DROP COLUMN IF EXISTS "created_by_membership_id";

--> statement-breakpoint
ALTER TABLE "affiliates" DROP CONSTRAINT IF EXISTS "fk_affiliates_org_user_mbr";

--> statement-breakpoint
ALTER TABLE "affiliates" DROP COLUMN IF EXISTS "user_membership_id";
