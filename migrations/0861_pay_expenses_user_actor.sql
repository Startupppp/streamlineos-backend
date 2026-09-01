-- 0861: EXPAND expenses with user_membership_id.
--
-- expenses.user_id is the employee who owns the expense claim. It appears in applyScope
-- ownerColumn and direct eq predicates gating ESS access. Moving ownership to
-- organization_members.id makes revocation revoke. The approver_membership_id column
-- already exists and is managed separately. The legacy user_id is kept for the
-- dual-read window and for financial record integrity.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "expenses" e
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = e.org_id
  AND om.user_id = e.user_id
  AND e."user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "expenses"
  ADD CONSTRAINT "fk_expenses_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_expenses_org_user_actor"
  ON "expenses" ("org_id", "user_membership_id");
