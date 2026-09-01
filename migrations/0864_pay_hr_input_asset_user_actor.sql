-- 0864: EXPAND hr_payroll_input_snapshots, hr_payroll_adjustments, asset_returns with
-- user_membership_id.
--
-- hr_payroll_input_snapshots.user_id is the employee subject for snapshot lookup.
-- hr_payroll_adjustments.user_id is the employee subject for adjustment targeting.
-- asset_returns.user_id identifies the employee returning the asset.
-- All three have no-drop user_id; user_membership_id is the live auth pointer.
-- asset_returns service lives in modules/hr (HR lane territory); this migration
-- adds the schema column only — service cutover is a handoff to the HR lane.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "hr_payroll_input_snapshots" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "hr_payroll_input_snapshots" s
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = s.org_id
  AND om.user_id = s.user_id
  AND s."user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "hr_payroll_input_snapshots"
  ADD CONSTRAINT "fk_hr_payroll_input_snapshots_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_payroll_input_snapshots_org_user_actor"
  ON "hr_payroll_input_snapshots" ("org_id", "user_membership_id");

--> statement-breakpoint
ALTER TABLE "hr_payroll_adjustments" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "hr_payroll_adjustments" a
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = a.org_id
  AND om.user_id = a.user_id
  AND a."user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "hr_payroll_adjustments"
  ADD CONSTRAINT "fk_hr_payroll_adjustments_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_payroll_adjustments_org_user_actor"
  ON "hr_payroll_adjustments" ("org_id", "user_membership_id");

--> statement-breakpoint
ALTER TABLE "asset_returns" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "asset_returns" ar
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = ar.org_id
  AND om.user_id = ar.user_id
  AND ar."user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "asset_returns"
  ADD CONSTRAINT "fk_asset_returns_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_asset_returns_org_user_actor"
  ON "asset_returns" ("org_id", "user_membership_id");
