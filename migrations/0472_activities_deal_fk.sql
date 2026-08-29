-- The third of the timeline's three anchors, which never got its foreign key.
--
-- `0215` gave `activities` composite FKs to `business_parties` and `subjects`,
-- and `chk_activities_one_anchor` enforces that a row anchors to exactly one of
-- party, deal or subject. The deal arm was left without referential integrity —
-- so a timeline entry could name a deal in another organisation, or one that
-- was never created, and nothing would refuse it.
--
-- `0214` created `uniq_deals_org_id` on ("org_id", "id") for exactly this
-- purpose and `deal_stage_transitions` already points at it; this is the same
-- FK, on the same target, for the table that was missed.
--
-- `deal_id` is nullable and the default MATCH SIMPLE applies, so a row anchored
-- to a party or a subject skips the check entirely — which is what the exclusive
-- arc requires. `idx_activities_deal_timeline` already covers the referencing
-- side.
--
-- VALIDATE is deliberately not softened: if a row points at a deal that does not
-- exist, that is data the timeline is already lying about, and it should stop
-- the migration loudly rather than install a constraint that permits it.

-- WHY THIS MIGRATION NEVER APPLIED
--
-- `activities.deal_id` was declared `text` while `deals.id` is a `serial`. A
-- foreign key cannot span that, so the statement below failed with "foreign key
-- constraint cannot be implemented" on every database built from this journal —
-- which is why an empty-database run stopped here, and why the integrity hole
-- described above is still open everywhere.
--
-- The type is the bug, not just an obstacle to the constraint. `party_id` and
-- `subject_id` are genuinely text, and `deal_id` was made to match them for
-- symmetry with a key that is an integer. Every join between the two therefore
-- carried an implicit cast, which is also why `idx_activities_deal_timeline` was
-- not being used for them.
--
-- Converted before the constraint is added. `USING` is explicit rather than
-- relying on an assignment cast, and a non-numeric value stops the migration —
-- if one exists it is a deal id the timeline was already lying about, and
-- silently dropping it would hide the very thing this migration is for.

SET lock_timeout = '5s';

--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'activities'
      AND column_name = 'deal_id'
      AND data_type = 'text'
  ) THEN
    ALTER TABLE "activities"
      ALTER COLUMN "deal_id" TYPE INTEGER
      USING NULLIF(BTRIM("deal_id"), '')::INTEGER;
  END IF;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_activities_deal') THEN
    ALTER TABLE "activities" ADD CONSTRAINT "fk_activities_deal"
      FOREIGN KEY ("organization_id", "deal_id")
      REFERENCES "deals"("org_id", "id") ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

--> statement-breakpoint
ALTER TABLE "activities" VALIDATE CONSTRAINT "fk_activities_deal";
