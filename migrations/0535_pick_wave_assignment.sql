SET lock_timeout = '5s';
--> statement-breakpoint
-- B4, item 3 -- a wave is a walk somebody is doing, and nothing recorded who.
--
-- `inv_pick_lists` knew who created a wave and never who was walking it, so two
-- pickers handed the same wave both confirmed against the same lines. Each
-- confirm is bounded by `quantity_to_pick`, so the second one is refused rather
-- than doubling the quantity -- but only after the second picker has already
-- walked the aisle and taken the goods off the shelf. The double count is
-- physical before it is ever a number, and the only place to prevent it is
-- before the walk.
--
-- Claim is therefore an exclusive assignment: `assigned_to` is set by a
-- conditional update that only fires while it is null, so the loser of a race
-- is told the wave is taken instead of silently sharing it.
ALTER TABLE "inv_pick_lists"
  ADD COLUMN IF NOT EXISTS "assigned_to" text;
--> statement-breakpoint
ALTER TABLE "inv_pick_lists"
  ADD COLUMN IF NOT EXISTS "claimed_at" timestamp;
--> statement-breakpoint
-- Split, per the migration rules: a bare `ADD CONSTRAINT ... FOREIGN KEY` takes
-- ACCESS EXCLUSIVE on both sides for the whole validating scan, and one of the
-- sides here is the global `users` table -- every tenant's authentication reads
-- queue behind it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_pick_lists_assigned_to'
  ) THEN
    ALTER TABLE "inv_pick_lists"
      ADD CONSTRAINT "fk_inv_pick_lists_assigned_to"
      FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "inv_pick_lists" VALIDATE CONSTRAINT "fk_inv_pick_lists_assigned_to";
--> statement-breakpoint
-- The pair moves together or the claim is unreadable: an `assigned_to` with no
-- `claimed_at` cannot say when the walk started, and a `claimed_at` with no
-- assignee names a walk nobody is doing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_pick_lists_claim_pair'
  ) THEN
    ALTER TABLE "inv_pick_lists"
      ADD CONSTRAINT "chk_inv_pick_lists_claim_pair" CHECK (
        ("assigned_to" IS NULL AND "claimed_at" IS NULL)
        OR ("assigned_to" IS NOT NULL AND "claimed_at" IS NOT NULL)
      ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "inv_pick_lists" VALIDATE CONSTRAINT "chk_inv_pick_lists_claim_pair";
--> statement-breakpoint
-- "the waves waiting for a picker" and "the waves this picker is walking" are
-- the two queries the workbench makes, and both filter on org, assignee and
-- status. Tenant-leading, per the composite-index rule.
--
-- Plain rather than CONCURRENTLY: the runner wraps every pending migration in
-- one transaction and `CREATE INDEX CONCURRENTLY` cannot appear inside one --
-- the same constraint 0533 documents. `inv_pick_lists` is small enough that the
-- SHARE lock is momentary.
CREATE INDEX IF NOT EXISTS "idx_inv_pick_org_assignee"
  ON "inv_pick_lists" ("org_id", "assigned_to", "status");
