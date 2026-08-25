-- Custom SQL migration file, put your code below! --

-- Ticket 08. Three things the pipeline needs before it can be advanced by the
-- system rather than by a person:
--
--   1. A transition ledger whose actor may be a machine.
--   2. Money in integer minor units, with the legacy decimal derived from it so
--      the two cannot disagree.
--   3. A deal that points at a party and at what is being transacted.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deal_stage_transitions" (
  "deal_stage_transition_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "deal_id" integer NOT NULL,
  "pipeline_id" text,
  "from_stage" text,
  "to_stage" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_user_id" text,
  "actor_label" text,
  "reason" text,
  "occurred_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- A human transition without a person, or a system one wearing someone's name,
-- would both make the review feed lie. The database refuses each rather than
-- leaving it to every caller to remember.
ALTER TABLE "deal_stage_transitions" ADD CONSTRAINT "chk_deal_stage_transition_actor"
  CHECK (
    ("actor_kind" = 'human'  AND "actor_user_id" IS NOT NULL) OR
    ("actor_kind" = 'system' AND "actor_user_id" IS NULL)
  );

--> statement-breakpoint
ALTER TABLE "deal_stage_transitions" ADD CONSTRAINT "fk_deal_stage_transitions_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "deal_stage_transitions" VALIDATE CONSTRAINT "fk_deal_stage_transitions_org";

--> statement-breakpoint
/*
 * The composite FK below needs a unique constraint on exactly ("org_id", "id"),
 * and nothing in this repository creates one — `uniq_deals_org_id` exists only
 * as a Drizzle declaration. It is present in every database built or touched by
 * `drizzle-kit push`, which is why this series applied cleanly; a database built
 * purely by running migrations in order would abort here with
 * `42830: there is no unique constraint matching given keys`, taking the whole
 * 0205-0233 series down with it.
 *
 * Promotes an existing unique index rather than duplicating it, following
 * `0324_recon_directory_party_fks.sql`.
 */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_deals_org_id') THEN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uniq_deals_org_id' AND relkind = 'i') THEN
      ALTER TABLE "deals" ADD CONSTRAINT "uniq_deals_org_id" UNIQUE USING INDEX "uniq_deals_org_id";
    ELSE
      ALTER TABLE "deals" ADD CONSTRAINT "uniq_deals_org_id" UNIQUE ("org_id", "id");
    END IF;
  END IF;
END $$;

--> statement-breakpoint
-- Composite tenant key, so a transition cannot reference another organisation's
-- deal and still satisfy referential integrity. `uniq_deals_org_id` is the target.
ALTER TABLE "deal_stage_transitions" ADD CONSTRAINT "fk_deal_stage_transitions_deal"
  FOREIGN KEY ("organization_id", "deal_id")
  REFERENCES "deals"("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "deal_stage_transitions" VALIDATE CONSTRAINT "fk_deal_stage_transitions_deal";

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deal_stage_transitions_deal"
  ON "deal_stage_transitions" ("organization_id", "deal_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deal_stage_transitions_actor"
  ON "deal_stage_transitions" ("organization_id", "actor_kind", "occurred_at");

--> statement-breakpoint
-- Seed the ledger from what history there is. `deal_activities` rows of type
-- stage_change carry the actor and both stages; every one of them was written by
-- a person, because a system actor was not representable until now.
INSERT INTO "deal_stage_transitions" (
  "deal_stage_transition_id", "organization_id", "deal_id",
  "from_stage", "to_stage", "actor_kind", "actor_user_id", "reason", "occurred_at"
)
SELECT
  gen_random_uuid()::text, a."org_id", a."deal_id",
  a."previous_value", a."new_value", 'human', a."user_id",
  'Backfilled from deal_activities', a."created_at"
FROM "deal_activities" a
WHERE a."type" = 'stage_change'
  AND a."new_value" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "deals" d WHERE d."id" = a."deal_id" AND d."org_id" = a."org_id")
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Money. Add the canonical column first and backfill it from the decimal.
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "value_minor" bigint;

--> statement-breakpoint
UPDATE "deals" SET "value_minor" = round(COALESCE("value", 0) * 100)::bigint
WHERE "value_minor" IS NULL;

--> statement-breakpoint
ALTER TABLE "deals" ALTER COLUMN "value_minor" SET DEFAULT 0;

--> statement-breakpoint
-- NOT NULL in two steps so it never takes ACCESS EXCLUSIVE for a full scan.
ALTER TABLE "deals" ADD CONSTRAINT "chk_deals_value_minor_present"
  CHECK ("value_minor" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "deals" VALIDATE CONSTRAINT "chk_deals_value_minor_present";
--> statement-breakpoint
ALTER TABLE "deals" ALTER COLUMN "value_minor" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "deals" DROP CONSTRAINT "chk_deals_value_minor_present";

--> statement-breakpoint
-- Now make the decimal derived. Only two code paths ever wrote it, both in the
-- deals module and both moved to value_minor in this change; the fifteen modules
-- that READ it are untouched and keep the same column and the same type. After
-- this a stray write raises an error instead of silently creating a second
-- version of the number.
ALTER TABLE "deals" DROP COLUMN "value";

--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "value" numeric(15, 2)
  GENERATED ALWAYS AS ("value_minor"::numeric / 100) STORED;

--> statement-breakpoint
-- The party this deal is with, and what is being transacted. Both nullable and
-- additive: lead_id and client_id still carry every existing deal.
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "party_id" text;
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "subject_id" text;

--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "fk_deals_party"
  FOREIGN KEY ("org_id", "party_id")
  REFERENCES "business_parties"("organization_id", "party_id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "deals" VALIDATE CONSTRAINT "fk_deals_party";

--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "fk_deals_subject"
  FOREIGN KEY ("org_id", "subject_id")
  REFERENCES "subjects"("organization_id", "subject_id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "deals" VALIDATE CONSTRAINT "fk_deals_subject";

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deals_org_party"
  ON "deals" ("org_id", "party_id") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deals_org_subject"
  ON "deals" ("org_id", "subject_id") WHERE "deleted_at" IS NULL;

--> statement-breakpoint
-- The RLS matrix, extended to the deal tables. Without a policy each is readable
-- organisation-wide, because grants arrive through ALTER DEFAULT PRIVILEGES and
-- a missing policy is silent.
ALTER TABLE "deals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "deals";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "deals"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "deals" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "deals" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "deal_activities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "deal_activities";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "deal_activities"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "deal_activities" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "deal_activities" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "deal_stage_transitions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "deal_stage_transitions";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "deal_stage_transitions"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "deal_stage_transitions" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "deal_stage_transitions" TO streamline_app;

--> statement-breakpoint
ANALYZE "deals";
--> statement-breakpoint
ANALYZE "deal_stage_transitions";
