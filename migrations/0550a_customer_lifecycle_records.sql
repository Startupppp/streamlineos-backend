-- Custom SQL migration file, put your code below! --

-- Phase 5 ticket 07. A won deal produces a customer lifecycle record, so
-- recurring revenue is visible before it is at risk rather than after it is lost.
--
-- The pipeline answers "will we win this" and nothing answered "will we keep
-- it". A deal that reached a won stage stopped moving, its row went quiet, and
-- the next thing anybody heard about that customer was a cancellation. These two
-- tables are the place the system can say otherwise: when the term ends, how
-- long it runs, what it is worth, and the evidence that accumulated in between.
--
-- Five things here are load-bearing.
--
-- `party_id` is the anchor and carries a COMPOSITE tenant foreign key, exactly
-- as `activities.party_id` (0215) and `relationship_states.party_id` (0520) do.
-- `business_parties` is canonical and the legacy identity tables were dropped;
-- one organisation's contract must not be able to reference another's customer
-- and still satisfy referential integrity.
--
-- `source_deal_id` is an INTEGER with a composite foreign key onto
-- `deals(org_id, id)`, unlike `activities.deal_id` and
-- `relationship_states.deal_id`, which are `text` and carry none. Those store
-- whatever an activity's anchor said it was; this is written by exactly one
-- caller — the closed-won transition in `deals.service.ts` — which holds a real
-- `deals.id`. There is no compatibility reason to weaken the edge.
--
-- `uniq_customer_lifecycles_deal` is the idempotency of the whole feature.
-- Deals move backwards and forwards through stages routinely (a reversed
-- approval, a corrected misclick) and a bulk stage change can reach the hook
-- twice concurrently. The service inserts `ON CONFLICT DO NOTHING` against this
-- index rather than reading first, because two checks can both miss and both
-- inserts land — and the customer would then appear twice in the renewal book
-- for one contract, with nothing erroring.
--
-- `impact` on a signal is SIGNED. A history that can only record harm produces a
-- score that only ever rises and saturates at 100 for every customer who has
-- ever had a bad week, at which point it ranks nothing. Negative is evidence
-- against churn.
--
-- No foreign key from `recorded_by_user_id` to `users`, following 0223:
-- `scripts/purge-user.mjs` deletes every row referencing `users` whatever the
-- delete rule says, so offboarding one account manager would erase the evidence
-- behind a customer's risk score.
--
-- Authored by hand; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_lifecycles" (
  "customer_lifecycle_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,

  -- The customer, as a Party. NOT NULL, which is why a lifecycle is not written
  -- for every won deal: a deal that names nobody resolvable has no customer
  -- whose revenue this could be, and a row for it would put untraceable money
  -- into the renewal forecast.
  "party_id" text NOT NULL,

  -- The deal that produced it. See the idempotency note above.
  "source_deal_id" integer NOT NULL,

  -- No 'renewed' in the vocabulary: a renewal ADVANCES this row rather than
  -- closing it and opening a successor, because the book's whole question is
  -- "when does this contract next come up" and a chain of closed rows makes that
  -- require a walk backwards. 'churned' (reached renewal, was not renewed) and
  -- 'cancelled' (ended inside the term) stay distinct, or every mid-term
  -- cancellation counts against a renewal that was never offered.
  "status" text DEFAULT 'active' NOT NULL,

  "started_on" date NOT NULL,
  "term_months" integer NOT NULL,

  -- Stored, not generated. The addition has to clamp the day of month (31
  -- January plus one month is 28 February, not 3 March) and a term that is later
  -- re-agreed keeps the date that was agreed rather than what arithmetic
  -- re-derives. `lifecycle-terms.ts` performs the same clamp Postgres does, and
  -- `lifecycle-terms.spec.ts` is what holds the two in agreement.
  "renewal_on" date NOT NULL,

  -- Integer minor units, like `deals.value_minor` it is copied from. There is
  -- deliberately NO currency column: the amount is denominated in
  -- `organizations.currency`, and a second copy of that fact is a second thing
  -- that can disagree with the deal this was made from.
  "contract_value_minor" bigint DEFAULT 0 NOT NULL,

  -- The one fact the row cannot re-derive after a renewal: `started_on` moves
  -- forward each time, so a second-year customer and a first-year one are
  -- otherwise indistinguishable.
  "renewal_count" integer DEFAULT 0 NOT NULL,

  -- Materialised from the signal history rather than computed on read, because
  -- the list this table exists to produce sorts on it and a sort on a value no
  -- index can hold degrades into reading the whole book.
  "risk_score" integer DEFAULT 0 NOT NULL,
  "risk_computed_at" timestamp,
  "last_signal_at" timestamp,

  "closed_reason" text,
  "closed_at" timestamp,

  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "customer_lifecycles" ADD CONSTRAINT "chk_customer_lifecycles_status"
  CHECK ("status" IN ('active', 'churned', 'cancelled'));

--> statement-breakpoint
-- A month-to-month deal at one end and a decade at the other. Outside that range
-- the number is a typo, and a typo here becomes a renewal date nobody acts on
-- because it is eighty years away.
ALTER TABLE "customer_lifecycles" ADD CONSTRAINT "chk_customer_lifecycles_term"
  CHECK ("term_months" BETWEEN 1 AND 120);

--> statement-breakpoint
-- The renewal date must be after the start. A term that ends before it began
-- would sit permanently at the top of the overdue list and never leave it.
ALTER TABLE "customer_lifecycles" ADD CONSTRAINT "chk_customer_lifecycles_dates"
  CHECK ("renewal_on" > "started_on");

--> statement-breakpoint
-- Money is never negative here and the score is the band vocabulary's range.
-- `risk_band()` maps 0..100; a stored 140 would have no band and render as
-- nothing on every surface that colours by one.
ALTER TABLE "customer_lifecycles" ADD CONSTRAINT "chk_customer_lifecycles_amounts"
  CHECK (
    "contract_value_minor" >= 0 AND
    "renewal_count" >= 0 AND
    "risk_score" BETWEEN 0 AND 100
  );

--> statement-breakpoint
-- Closed together or not at all. A status of 'churned' with no reason makes the
-- churn unmeasurable, and a reason on an active contract is a half-applied
-- close somebody will read as an ending.
ALTER TABLE "customer_lifecycles" ADD CONSTRAINT "chk_customer_lifecycles_closure"
  CHECK (
    ("status" = 'active' AND "closed_at" IS NULL AND "closed_reason" IS NULL) OR
    ("status" <> 'active' AND "closed_at" IS NOT NULL AND "closed_reason" IS NOT NULL)
  );

--> statement-breakpoint
ALTER TABLE "customer_lifecycles" ADD CONSTRAINT "fk_customer_lifecycles_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_lifecycles" VALIDATE CONSTRAINT "fk_customer_lifecycles_org";

--> statement-breakpoint
/*
 * The composite foreign keys below need unique constraints on exactly
 * ("organization_id", "party_id") and ("org_id", "id"). Both are present in the
 * live database — 0520 promoted the first, 0214 the second — but a database
 * built purely by running migrations in order would abort with
 * `42830: there is no unique constraint matching given keys` if either were only
 * a Drizzle declaration or only an index. Idempotent, following 0214 and 0520.
 */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_business_parties_org_party') THEN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uniq_business_parties_org_party' AND relkind = 'i') THEN
      ALTER TABLE "business_parties"
        ADD CONSTRAINT "uniq_business_parties_org_party" UNIQUE USING INDEX "uniq_business_parties_org_party";
    ELSE
      ALTER TABLE "business_parties"
        ADD CONSTRAINT "uniq_business_parties_org_party" UNIQUE ("organization_id", "party_id");
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_deals_org_id') THEN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uniq_deals_org_id' AND relkind = 'i') THEN
      ALTER TABLE "deals" ADD CONSTRAINT "uniq_deals_org_id" UNIQUE USING INDEX "uniq_deals_org_id";
    ELSE
      ALTER TABLE "deals" ADD CONSTRAINT "uniq_deals_org_id" UNIQUE ("org_id", "id");
    END IF;
  END IF;
END $$;

--> statement-breakpoint
-- CASCADE rather than SET NULL, following 0520: SET NULL over a composite key
-- nulls `organization_id` too, which is NOT NULL. It costs nothing in practice
-- -- parties are soft-deleted and nothing in `src/` hard-deletes one -- and the
-- path that does fire is an organisation being torn down.
ALTER TABLE "customer_lifecycles" ADD CONSTRAINT "fk_customer_lifecycles_party"
  FOREIGN KEY ("organization_id", "party_id")
  REFERENCES "business_parties"("organization_id", "party_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_lifecycles" VALIDATE CONSTRAINT "fk_customer_lifecycles_party";

--> statement-breakpoint
-- Deals are soft-deleted too, so this also only fires on organisation teardown.
ALTER TABLE "customer_lifecycles" ADD CONSTRAINT "fk_customer_lifecycles_deal"
  FOREIGN KEY ("organization_id", "source_deal_id")
  REFERENCES "deals"("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_lifecycles" VALIDATE CONSTRAINT "fk_customer_lifecycles_deal";

--> statement-breakpoint
-- One term per deal. This is what the closed-won hook's ON CONFLICT targets, so
-- it must exist before that code path can run at all. NOT per party: a customer
-- who buys a second product has two contracts with two renewal dates, and
-- folding them into one row would hide whichever renews first.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_customer_lifecycles_deal"
  ON "customer_lifecycles" ("organization_id", "source_deal_id");

--> statement-breakpoint
-- The renewal book: what is coming, soonest first. Leading with
-- organization_id because the RLS predicate is not leakproof and the planner
-- needs it in the index.
CREATE INDEX IF NOT EXISTS "idx_customer_lifecycles_renewal"
  ON "customer_lifecycles" ("organization_id", "status", "renewal_on");

--> statement-breakpoint
-- The triage read, which sorts on the score rather than the date.
CREATE INDEX IF NOT EXISTS "idx_customer_lifecycles_risk"
  ON "customer_lifecycles" ("organization_id", "status", "risk_score");

--> statement-breakpoint
-- Every contract this customer holds -- the account view's question -- and the
-- party foreign key's own delete-time lookup, which searches the same pair.
CREATE INDEX IF NOT EXISTS "idx_customer_lifecycles_party"
  ON "customer_lifecycles" ("organization_id", "party_id");

--> statement-breakpoint
-- The composite tenant key the signal table points at.
ALTER TABLE "customer_lifecycles" ADD CONSTRAINT "uniq_customer_lifecycles_org_id"
  UNIQUE ("organization_id", "customer_lifecycle_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_lifecycle_signals" (
  "lifecycle_signal_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "customer_lifecycle_id" text NOT NULL,

  "kind" text NOT NULL,

  -- Signed: positive is pressure toward churn, negative is evidence against it.
  -- Stored rather than looked up from the kind at read time, so re-tuning the
  -- default table never rewrites the risk history of a customer nothing happened
  -- to.
  "impact" integer NOT NULL,

  -- When the thing HAPPENED, not when it was filed. The decay reads this, so a
  -- backfilled escalation from March weighs what March weighs; defaulting it to
  -- the insert time would make every import look like a crisis this morning.
  "observed_at" timestamp DEFAULT now() NOT NULL,

  "source" text DEFAULT 'system' NOT NULL,
  -- No FK to users. See 0223 and the header note.
  "recorded_by_user_id" text,

  "note" text,

  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "customer_lifecycle_signals" ADD CONSTRAINT "chk_customer_lifecycle_signals_kind"
  CHECK ("kind" IN (
    'support-escalation', 'invoice-overdue', 'champion-departed', 'usage-decline',
    'detractor-response', 'relationship-silence', 'expansion-interest',
    'renewal-commitment', 'note'
  ));

--> statement-breakpoint
ALTER TABLE "customer_lifecycle_signals" ADD CONSTRAINT "chk_customer_lifecycle_signals_source"
  CHECK ("source" IN ('system', 'human'));

--> statement-breakpoint
-- The bound `clampImpact` also enforces. Stated on both sides because a producer
-- that bypassed the service would otherwise be able to write a single signal
-- that pins every score at 100 forever.
ALTER TABLE "customer_lifecycle_signals" ADD CONSTRAINT "chk_customer_lifecycle_signals_impact"
  CHECK ("impact" BETWEEN -100 AND 100);

--> statement-breakpoint
ALTER TABLE "customer_lifecycle_signals" ADD CONSTRAINT "fk_customer_lifecycle_signals_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_lifecycle_signals" VALIDATE CONSTRAINT "fk_customer_lifecycle_signals_org";

--> statement-breakpoint
ALTER TABLE "customer_lifecycle_signals" ADD CONSTRAINT "fk_customer_lifecycle_signals_lifecycle"
  FOREIGN KEY ("organization_id", "customer_lifecycle_id")
  REFERENCES "customer_lifecycles"("organization_id", "customer_lifecycle_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_lifecycle_signals" VALIDATE CONSTRAINT "fk_customer_lifecycle_signals_lifecycle";

--> statement-breakpoint
-- The history read (newest first), the decay window's range scan, and the
-- composite foreign key's own delete-time lookup -- one index serves all three.
CREATE INDEX IF NOT EXISTS "idx_customer_lifecycle_signals_lifecycle"
  ON "customer_lifecycle_signals" ("organization_id", "customer_lifecycle_id", "observed_at");

--> statement-breakpoint
-- Without a policy each table is readable organisation-wide: grants arrive
-- through ALTER DEFAULT PRIVILEGES, so a missing policy is silent. These hold
-- what every customer pays and how likely we think they are to leave, which is
-- among the most disclosive data in the product.
ALTER TABLE "customer_lifecycles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "customer_lifecycles";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_lifecycles"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "customer_lifecycles" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_lifecycles" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "customer_lifecycle_signals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "customer_lifecycle_signals";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_lifecycle_signals"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "customer_lifecycle_signals" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_lifecycle_signals" TO streamline_app;

--> statement-breakpoint
ANALYZE "customer_lifecycles";
--> statement-breakpoint
ANALYZE "customer_lifecycle_signals";
