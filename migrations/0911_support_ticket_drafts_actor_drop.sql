-- 0911: Contract support draft ownership to organization membership identity.
-- The expand/backfill and FK validation completed in 0865 and 0866.

SET lock_timeout = '5s';

--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "support_ticket_drafts"
    WHERE "user_membership_id" IS NULL
  ) THEN
    RAISE EXCEPTION '0911 blocked: support ticket draft membership backfill is incomplete';
  END IF;
END $$;

--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_support_ticket_drafts_ticket_user";

--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_support_ticket_drafts_ticket_membership"
  ON "support_ticket_drafts" ("ticket_id", "user_membership_id");

--> statement-breakpoint
ALTER TABLE "support_ticket_drafts"
  ADD CONSTRAINT "chk_support_ticket_drafts_membership_not_null"
  CHECK ("user_membership_id" IS NOT NULL) NOT VALID;

--> statement-breakpoint
ALTER TABLE "support_ticket_drafts"
  VALIDATE CONSTRAINT "chk_support_ticket_drafts_membership_not_null";

--> statement-breakpoint
ALTER TABLE "support_ticket_drafts"
  ALTER COLUMN "user_membership_id" SET NOT NULL;

--> statement-breakpoint
ALTER TABLE "support_ticket_drafts"
  DROP CONSTRAINT "chk_support_ticket_drafts_membership_not_null";

--> statement-breakpoint
ALTER TABLE "support_ticket_drafts"
  DROP COLUMN IF EXISTS "user_id";

--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "support_saved_views"
    WHERE "owner_id" IS NOT NULL
      AND "owner_membership_id" IS NULL
  ) THEN
    RAISE EXCEPTION '0911 blocked: support saved-view owner backfill is incomplete';
  END IF;
END $$;

--> statement-breakpoint
DROP INDEX IF EXISTS "idx_support_saved_views_org_owner";

--> statement-breakpoint
ALTER TABLE "support_saved_views"
  DROP COLUMN IF EXISTS "owner_id";

--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "support_macros"
    WHERE "created_by" IS NOT NULL
      AND "created_by_membership_id" IS NULL
  ) THEN
    RAISE EXCEPTION '0911 blocked: support macro creator backfill is incomplete';
  END IF;
END $$;

--> statement-breakpoint
ALTER TABLE "support_macros"
  DROP COLUMN IF EXISTS "created_by";
