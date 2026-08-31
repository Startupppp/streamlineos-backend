SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "org_units" ADD COLUMN "head_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "org_units"
  ADD CONSTRAINT "fk_org_units_head_membership"
  FOREIGN KEY ("org_id", "head_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("head_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "org_units"
  VALIDATE CONSTRAINT "fk_org_units_head_membership";
--> statement-breakpoint
ALTER TABLE "org_unit_members" ADD COLUMN "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "org_unit_members"
  ADD CONSTRAINT "fk_org_unit_members_membership"
  FOREIGN KEY ("org_id", "membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "org_unit_members"
  VALIDATE CONSTRAINT "fk_org_unit_members_membership";
--> statement-breakpoint
UPDATE "org_units" t
SET "head_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = t.org_id
  AND om.user_id = t.head_user_id
  AND t.head_user_id IS NOT NULL
  AND t.head_membership_id IS NULL;
--> statement-breakpoint
UPDATE "org_unit_members" t
SET "membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = t.org_id
  AND om.user_id = t.user_id
  AND t.user_id IS NOT NULL
  AND t.membership_id IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_units_head_membership"
  ON "org_units" ("org_id", "head_membership_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_unit_members_membership"
  ON "org_unit_members" ("org_id", "membership_id");
