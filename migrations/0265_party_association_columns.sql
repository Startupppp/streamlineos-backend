-- Custom SQL migration file, put your code below! --

-- Party learns the three associations the legacy rows were still holding.
--
-- Ticket 08's contract step cannot drop `contacts`, `clients` and
-- `crm_organizations` while eleven readers still join them, and by this point
-- every one of those joins is there for the SAME reason: an association column
-- Party has nowhere to put. Not a field -- the fields all moved in 0240/0262 --
-- a *link*. Four columns across three tables, three distinct relations:
--
--   `clients.lead_id`            the lead this record was converted out of
--   `contacts.lead_id`           the lead this record was created against
--   `contacts.deal_id`           the deal this person is attached to
--   `crm_organizations.parent_id` the company that owns this company
--
-- 0262 did exactly this for the fifth one, `contacts.organization_id`, and the
-- shape is deliberately identical: a party-to-party (or party-to-deal) link with
-- a COMPOSITE tenant foreign key, so a link reaching into another organisation is
-- unrepresentable rather than merely unlikely.
--
-- `converted_from_party_id` is ONE column for the two `lead_id`s, because they
-- are one relation. `clients.lead_id` is "which lead became this client" and
-- `contacts.lead_id` is "which lead this contact was raised against"; both name
-- the lead record this row came out of, and 0241 gave that lead a party of its
-- own. Two columns would be the merged model carrying two names for one field,
-- which is the mistake 0240 refused three times.
--
-- `parent_party_id` is NOT folded into `employer_party_id`, and that is the same
-- decision `party-mirror-fields.ts` recorded when it left the hierarchy behind:
-- a subsidiary's parent is not its employer, and one column serving both would
-- make the name a lie. It is a second link of the same shape, not a second
-- meaning for the first. `crm-organizations.service.ts` names converging the
-- hierarchy as the follow-up its merge revert is waiting on; this is it.
--
-- `primary_deal_id` stays an integer `deals` id rather than becoming a party
-- link, because a deal is not a party. `deals.party_id` exists and points the
-- other way -- "the party this deal is WITH", the customer -- and it is nullable
-- and unbackfilled, so reading the relation off it would silently drop every
-- deal predating phase 1. Different question, different column.
--
-- ON DELETE CASCADE on all three, where the instinct is SET NULL. A composite
-- SET NULL nulls BOTH columns and `organization_id` is NOT NULL, so the delete
-- would simply fail; `ON DELETE SET NULL (column)` would fix that and needs
-- Postgres 15, which this deployment does not pin. CASCADE is safe here as a
-- fact rather than a hope, established the way 0262 established it: the
-- repository was grepped and NOTHING hard-deletes a party, a lead, a client, a
-- company or a deal -- there is no `delete(deals)`, no `delete(clients)`, no
-- `DELETE FROM crm_organizations` anywhere outside a test fixture, and all five
-- tables soft-delete through `deleted_at`. The only DELETE that ever reaches
-- either side is the tenant cascade from `organizations`, where both rows are
-- going together anyway. If a hard delete of a deal is ever added, THIS
-- CONSTRAINT MUST BE REVISITED FIRST: cascading a deal's deletion into the
-- person it was with is not a trade this migration is making, it is a case it
-- has established does not arise.
--
-- NO ACTION was the safer-looking alternative and is worse: the tenant cascade
-- deletes `deals` and `business_parties` in an order Postgres does not promise,
-- so a NO ACTION reference from one to the other can abort deleting an
-- organisation -- which is the one delete that definitely happens.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
-- The lead a client was converted out of, or a contact was raised against.
ALTER TABLE "business_parties" ADD COLUMN IF NOT EXISTS "converted_from_party_id" text;
--> statement-breakpoint
-- The company that owns this company: the account hierarchy, as parties.
ALTER TABLE "business_parties" ADD COLUMN IF NOT EXISTS "parent_party_id" text;
--> statement-breakpoint
-- The deal this person is attached to. An integer `deals` id, not a party.
ALTER TABLE "business_parties" ADD COLUMN IF NOT EXISTS "primary_deal_id" integer;

--> statement-breakpoint
/*
 * The composite FKs below need a unique constraint on exactly
 * ("organization_id", "party_id"). 0240 promotes it and so do 0250, 0260, 0262,
 * 0263, 0290 and 0324 -- each independently, because a migration may not assume
 * a later one ran. Promotes an existing unique index rather than duplicating it:
 * a dependent foreign key blocks a DROP INDEX, so `ADD CONSTRAINT ... USING
 * INDEX` is the only way through.
 */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_business_parties_org_party') THEN
    IF EXISTS (
      SELECT 1 FROM pg_class WHERE relname = 'uniq_business_parties_org_party' AND relkind = 'i'
    ) THEN
      ALTER TABLE "business_parties"
        ADD CONSTRAINT "uniq_business_parties_org_party" UNIQUE USING INDEX "uniq_business_parties_org_party";
    ELSE
      ALTER TABLE "business_parties"
        ADD CONSTRAINT "uniq_business_parties_org_party" UNIQUE ("organization_id", "party_id");
    END IF;
  END IF;
END $$;

--> statement-breakpoint
/*
 * `uniq_deals_org_id` is a Drizzle declaration that 0214 and 0290 each had to
 * create for the same reason, and this is the third time: a database built purely
 * by running migrations in order has the index but not the constraint, and the
 * foreign key below would abort with `42830: there is no unique constraint
 * matching given keys`.
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
/*
 * The indexes first, for the reason 0262 gave: without them each foreign key's
 * delete-time lookup is a sequential scan of the whole table, and the VALIDATE
 * below reads every row. All three are partial, because almost no party has any
 * of these links -- a company was not converted from a lead, a lead has no
 * parent company, and a person is attached to a deal only if somebody said so.
 */
CREATE INDEX IF NOT EXISTS "idx_business_parties_converted_from"
  ON "business_parties" ("organization_id", "converted_from_party_id")
  WHERE "converted_from_party_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_business_parties_parent"
  ON "business_parties" ("organization_id", "parent_party_id")
  WHERE "parent_party_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_business_parties_primary_deal"
  ON "business_parties" ("organization_id", "primary_deal_id")
  WHERE "primary_deal_id" IS NOT NULL;

--> statement-breakpoint
/*
 * Each ADD CONSTRAINT below is guarded on `pg_constraint`, which the rest of this
 * series does for its unique-index promotions and does NOT do for its foreign
 * keys. Re-running 0262 fails on exactly this line, and 0263 says in a comment
 * that it drops a policy first "so a re-run is clean" -- so the intent is there
 * and the foreign keys simply missed it.
 *
 * It is not about running a migration twice on purpose. It is about running it
 * again after it stopped in the middle. Neon drops connections, and VALIDATE
 * CONSTRAINT on a large table is the statement most likely to be interrupted --
 * at which point the constraint exists NOT VALID, the migration is unrecorded,
 * and the retry dies on ADD CONSTRAINT before ever reaching the VALIDATE that
 * would have finished the job. That is a bad thing to discover during an
 * incident.
 *
 * VALIDATE stays unguarded: it is already a no-op on an validated constraint,
 * and after the guard above the constraint always exists.
 */
-- NOT VALID then VALIDATE, never one statement: ADD CONSTRAINT ... FOREIGN KEY
-- takes ACCESS EXCLUSIVE on both sides while it installs the triggers, and two
-- of the three have the same large table on both sides.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_business_parties_converted_from') THEN
    ALTER TABLE "business_parties" ADD CONSTRAINT "fk_business_parties_converted_from"
      FOREIGN KEY ("organization_id", "converted_from_party_id")
      REFERENCES "business_parties"("organization_id", "party_id")
      ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "business_parties" VALIDATE CONSTRAINT "fk_business_parties_converted_from";

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_business_parties_parent') THEN
    ALTER TABLE "business_parties" ADD CONSTRAINT "fk_business_parties_parent"
      FOREIGN KEY ("organization_id", "parent_party_id")
      REFERENCES "business_parties"("organization_id", "party_id")
      ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "business_parties" VALIDATE CONSTRAINT "fk_business_parties_parent";

--> statement-breakpoint
/*
 * The one link `contacts` never had a constraint for at all: `contacts.deal_id`
 * is a bare integer with no foreign key, so a contact can and does point at a
 * deal that was deleted or belongs to another tenant. Party gets the constraint
 * the legacy column never had, which is why 0266 filters the backfill through an
 * EXISTS rather than copying the column across.
 */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_business_parties_primary_deal') THEN
    ALTER TABLE "business_parties" ADD CONSTRAINT "fk_business_parties_primary_deal"
      FOREIGN KEY ("organization_id", "primary_deal_id")
      REFERENCES "deals"("org_id", "id")
      ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "business_parties" VALIDATE CONSTRAINT "fk_business_parties_primary_deal";

--> statement-breakpoint
-- Nobody is converted from themselves and nobody owns themselves. A one-hop
-- cycle is the only one a constraint can see; deeper ones stay the application's
-- problem, as they already are for `crm_organizations.parent_id` -- which is what
-- `CrmOrganizationsInsightsService.wouldCreateCycle` exists to check.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_business_parties_converted_from_not_self') THEN
    ALTER TABLE "business_parties" ADD CONSTRAINT "chk_business_parties_converted_from_not_self"
      CHECK ("converted_from_party_id" IS NULL OR "converted_from_party_id" <> "party_id") NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "business_parties" VALIDATE CONSTRAINT "chk_business_parties_converted_from_not_self";

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_business_parties_parent_not_self') THEN
    ALTER TABLE "business_parties" ADD CONSTRAINT "chk_business_parties_parent_not_self"
      CHECK ("parent_party_id" IS NULL OR "parent_party_id" <> "party_id") NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "business_parties" VALIDATE CONSTRAINT "chk_business_parties_parent_not_self";

--> statement-breakpoint
ANALYZE "business_parties";
