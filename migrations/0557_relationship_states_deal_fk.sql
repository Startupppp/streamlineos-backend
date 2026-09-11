-- The relationship materialiser's deal anchor, given the same treatment as the
-- timeline's in 0472.
--
-- `relationship_states.deal_id` was text against `deals.id`, which is a
-- `serial`. Unlike `autonomous_decisions.deal_id` — an audit column that is text
-- on purpose, kept whether or not the thing it describes still exists — this one
-- names a live deal and is read back on every sweep. Text cost it the same two
-- things it cost `activities`: no foreign key could span the boundary, so a
-- relationship could name a deal in another organisation or one that was never
-- created; and `idx_relationship_states_deal` sat unused behind an implicit
-- cast on every lookup.
--
-- `relationship_states` is a materialised projection of activity, so there is
-- nothing here that could not be rebuilt. The conversion is still explicit and
-- still refuses a non-numeric value rather than dropping it: one would mean the
-- materialiser had written an anchor it could never read back.

SET lock_timeout = '5s';

--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'relationship_states'
      AND column_name = 'deal_id'
      AND data_type = 'text'
  ) THEN
    ALTER TABLE "relationship_states"
      ALTER COLUMN "deal_id" TYPE INTEGER
      USING NULLIF(BTRIM("deal_id"), '')::INTEGER;
  END IF;
END $$;

--> statement-breakpoint
-- `uniq_deals_org_id` on ("org_id", "id") is the target, the same one
-- `deal_stage_transitions` and now `activities` point at. CASCADE because a
-- relationship state is a projection: when the deal goes, the summary of how it
-- was going goes with it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_relationship_states_deal'
  ) THEN
    ALTER TABLE "relationship_states" ADD CONSTRAINT "fk_relationship_states_deal"
      FOREIGN KEY ("organization_id", "deal_id")
      REFERENCES "deals"("org_id", "id") ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

--> statement-breakpoint
ALTER TABLE "relationship_states" VALIDATE CONSTRAINT "fk_relationship_states_deal";

--> statement-breakpoint
-- The `ALTER COLUMN ... TYPE` above rewrites the table, which leaves the planner
-- with stale statistics and an empty visibility map. Skipping this is how a plan
-- that should read 53 blocks reads 201,875 -- and the whole point of the key is
-- to make the deal index usable, which the planner has to be told about.
ANALYZE "relationship_states";
