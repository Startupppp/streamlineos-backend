SET lock_timeout = '5s';

ALTER TABLE "ownership_transfers"
  ADD COLUMN IF NOT EXISTS "initiated_by_membership_id" integer;
--> statement-breakpoint

UPDATE "ownership_transfers"
SET "initiated_by_membership_id" = "from_membership_id"
WHERE "initiated_by_membership_id" IS NULL;
--> statement-breakpoint

DO $$
DECLARE unmapped integer;
BEGIN
  SELECT count(*) INTO unmapped
  FROM "ownership_transfers"
  WHERE "initiated_by_membership_id" IS NULL;
  IF unmapped > 0 THEN
    RAISE EXCEPTION 'ownership_transfers: % row(s) could not be given an initiator. They are reported, not dropped.', unmapped;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "ownership_transfers"
  ALTER COLUMN "initiated_by_membership_id" SET NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_ownership_transfers_initiator'
  ) THEN
    ALTER TABLE "ownership_transfers"
      ADD CONSTRAINT "fk_ownership_transfers_initiator"
      FOREIGN KEY ("org_id", "initiated_by_membership_id")
      REFERENCES "organization_members" ("org_id", "id")
      ON DELETE RESTRICT
      NOT VALID;
    ALTER TABLE "ownership_transfers"
      VALIDATE CONSTRAINT "fk_ownership_transfers_initiator";
  END IF;
END $$;
