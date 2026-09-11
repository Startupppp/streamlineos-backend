-- 0534 — B1. A goods receipt gets a life before it posts stock.
--
-- `inv_grns` had no status column, so recording a delivery and posting it to the
-- stock ledger were the same act. There was nowhere to put a pallet that had
-- arrived but not been counted, no way to note a discrepancy before committing
-- to it, and nothing for quality to look at between the two. Every receipt was
-- final the instant it was typed.
--
-- Three things arrive here:
--
--   * `inv_grn_status` and the lifecycle columns on `inv_grns`. Existing rows
--     are backfilled to POSTED — every receipt that exists today did move
--     stock — and only then does the column default flip to DRAFT, so history
--     reads correctly and new documents start unposted.
--   * lot capture on `inv_grn_lines`. These used to be written straight into
--     `inv_lots` at receipt time; a draft that did that would put traceable
--     batches into the catalogue for goods nobody had accepted.
--   * `inv_grn_line_serials`, for the same reason at the unit grain. A row per
--     serial rather than an array, so two scanners cannot record the same unit
--     twice on one line and a partially-scanned line can be appended to.
--
-- Locking notes, per §3 Migrations. Every ALTER here is catalogue-only:
-- `ADD COLUMN` with a constant default has not rewritten a table since PG11,
-- and the two foreign keys are added `NOT VALID` and validated in their own
-- statements so neither `ADD` takes ACCESS EXCLUSIVE across a scan. The
-- `CREATE INDEX`es are the plain form on purpose: drizzle's runner wraps every
-- pending migration in one transaction and `CREATE INDEX CONCURRENTLY` cannot
-- appear inside a transaction block at all — see the header of 0533. Both
-- tables are small (one GRN row across the estate today), so the plain build is
-- the right trade rather than a compromise.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inv_grn_status') THEN
    CREATE TYPE "inv_grn_status" AS ENUM ('DRAFT', 'COUNTING', 'QUALITY_REVIEW', 'POSTED', 'CANCELLED');
  END IF;
END $$;
--> statement-breakpoint

-- POSTED as the arriving default, so the backfill is the column addition itself
-- rather than a second pass over the table. The default is corrected to DRAFT
-- below, once every historical row already carries POSTED.
ALTER TABLE "inv_grns" ADD COLUMN IF NOT EXISTS "status" "inv_grn_status" DEFAULT 'POSTED' NOT NULL;
--> statement-breakpoint

ALTER TABLE "inv_grns" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
--> statement-breakpoint

ALTER TABLE "inv_grns" ADD COLUMN IF NOT EXISTS "posted_by" text;
--> statement-breakpoint

ALTER TABLE "inv_grns" ADD COLUMN IF NOT EXISTS "posted_at" timestamp;
--> statement-breakpoint

ALTER TABLE "inv_grns" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint

-- Who posted it and when: for every row that predates this migration, that is
-- whoever recorded it, at the moment they did, because recording it was posting
-- it. Written only where it is still absent so a re-run cannot rewrite history.
UPDATE "inv_grns"
   SET "posted_by" = "created_by",
       "posted_at" = "created_at"
 WHERE "status" = 'POSTED'
   AND "posted_at" IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_inv_grns_posted_by'
       AND conrelid = 'inv_grns'::regclass
  ) THEN
    ALTER TABLE "inv_grns"
      ADD CONSTRAINT "fk_inv_grns_posted_by"
      FOREIGN KEY ("posted_by") REFERENCES "users" ("id")
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_inv_grns_posted_by'
       AND conrelid = 'inv_grns'::regclass
       AND NOT convalidated
  ) THEN
    ALTER TABLE "inv_grns" VALIDATE CONSTRAINT "fk_inv_grns_posted_by";
  END IF;
END $$;
--> statement-breakpoint

-- The receiving workbench filters on status and orders by date, and the org
-- leads because RLS adds `org_id = app.current_org_id()` to every read here.
CREATE INDEX IF NOT EXISTS "idx_inv_grn_org_status"
  ON "inv_grns" ("org_id", "status", "received_date");
--> statement-breakpoint

ALTER TABLE "inv_grn_lines" ADD COLUMN IF NOT EXISTS "lot_number" text;
--> statement-breakpoint

ALTER TABLE "inv_grn_lines" ADD COLUMN IF NOT EXISTS "expiry_date" date;
--> statement-breakpoint

ALTER TABLE "inv_grn_lines" ADD COLUMN IF NOT EXISTS "manufacture_date" date;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_grn_line_serials" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "grn_line_id" integer NOT NULL REFERENCES "inv_grn_lines"("id") ON DELETE CASCADE,
  "serial_number" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_grn_line_serials_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_grn_line_serials_grn_line_id_org'
  ) THEN
    ALTER TABLE "inv_grn_line_serials"
      ADD CONSTRAINT "fk_inv_grn_line_serials_grn_line_id_org"
      FOREIGN KEY ("org_id", "grn_line_id")
      REFERENCES "inv_grn_lines" ("org_id", "id") ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_inv_grn_line_serials_grn_line_id_org'
       AND NOT convalidated
  ) THEN
    ALTER TABLE "inv_grn_line_serials"
      VALIDATE CONSTRAINT "fk_inv_grn_line_serials_grn_line_id_org";
  END IF;
END $$;
--> statement-breakpoint

-- The reason this is a table and not an array: one unit may be scanned into one
-- receipt line exactly once, and only the database can hold that under two
-- concurrent scanners.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_grn_line_serials_line_number"
  ON "inv_grn_line_serials" ("org_id", "grn_line_id", "serial_number");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_grn_line_serials_line"
  ON "inv_grn_line_serials" ("grn_line_id");
--> statement-breakpoint

-- Grants reach new tables through ALTER DEFAULT PRIVILEGES, so a tenant table
-- without a policy is readable org-wide and silently so — 0514 is the whole
-- story of that. Enabled and policied in the same migration that creates it.
ALTER TABLE "inv_grn_line_serials" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS "tenant_isolation" ON "inv_grn_line_serials";
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "inv_grn_line_serials"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

-- Every inventory line table takes its tenant from its parent rather than from
-- the caller, so a client cannot attribute a serial to another organisation and
-- the composite foreign key above always has an org to match on.
DROP TRIGGER IF EXISTS "trg_set_org_id" ON "inv_grn_line_serials";
--> statement-breakpoint

CREATE TRIGGER "trg_set_org_id"
  BEFORE INSERT ON "inv_grn_line_serials"
  FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent('inv_grn_lines', 'id', 'org_id', 'grn_line_id');
