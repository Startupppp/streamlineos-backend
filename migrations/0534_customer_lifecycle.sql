-- Custom SQL migration file, put your code below! --

-- Phase 6, tickets 07 to 09. The CRM gains an "after".
--
-- Everything before this phase models the pursuit: a lead, a deal, a stage, a
-- close. The moment the deal closes the product stops having an opinion, so
-- recurring revenue becomes visible only once it has already gone. These four
-- tables are what makes a renewal a thing somebody can see coming.
--
-- Six things here are load-bearing.
--
-- The anchor is the PARTY, and `uniq_customer_lifecycles_party` is what makes
-- "one customer, one lifecycle view" a database property rather than a habit.
-- `client_accounts` was the obvious alternative and is one of five places this
-- platform records a customer -- two accounts for one company would be two
-- renewal dates and two health scores that disagree, with nothing to say which
-- was right.
--
-- Every party edge is a COMPOSITE tenant foreign key onto
-- `business_parties (organization_id, party_id)`, exactly as `activities.party_id`
-- (0215) and `relationship_states.party_id` (0520) do. Without the tenant column
-- in the key, one organisation's lifecycle could reference another's customer
-- and still satisfy referential integrity.
--
-- `origin_deal_id` is `text` and carries NO foreign key, also exactly as
-- `activities.deal_id` and `relationship_states.deal_id` do. `deals.id` is an
-- integer, the go-forward model stores whatever the anchor said it was, and a
-- cascade from a deleted deal must not take a live contract's record with it.
--
-- `customer_health_scores` and `customer_lifecycle_signals` are APPEND-ONLY, and
-- that is the fix for the defect this phase inherited rather than a storage
-- preference. `client_health_scores` was recomputed with
-- `DELETE ... WHERE org_id = $1` followed by an `INSERT`, so it could only ever
-- answer "what is the number now": a customer sliding from 80 to 45 over a
-- quarter was indistinguishable from one that had always been 45, and a trend --
-- the entire reason anybody watches health -- could not be computed at all.
-- The grants below withhold UPDATE from the application role on both, so a row
-- once written cannot be rewritten. DELETE is granted because tenant offboarding
-- needs it; UPDATE has no legitimate caller and its absence is what makes the
-- accumulation a property instead of a promise.
--
-- `client_health_scores` is SUPERSEDED, not duplicated. Nothing writes it after
-- this ships -- `cs-health.service.ts` is the only reader and writer it ever had
-- and now writes here. It is left in place rather than dropped so the existing
-- rows survive one release for anybody who wants to compare; the drop belongs in
-- a contract migration once nothing reads it.
--
-- `contract_value_minor` and `observed_value` are integer minor units and plain
-- integers respectively. Money is minor units platform-wide -- `deals.value` is
-- already a GENERATED column over `deals.value_minor` for exactly this reason --
-- and a decimal here is drift on any sum over a book of contracts.
--
-- Authored by hand; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
/*
 * The composite foreign keys below need a unique constraint on exactly
 * ("organization_id", "party_id"). It is present in the live database, but a
 * database built purely by running migrations in order would abort here with
 * `42830: there is no unique constraint matching given keys` if it were only a
 * Drizzle declaration or only an index. Promotes the existing unique index
 * rather than duplicating it, following 0214, 0250, 0290 and 0520.
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
END $$;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_lifecycles" (
  "customer_lifecycle_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "party_id" text NOT NULL,

  -- The won deal this came out of. Text, no foreign key -- see the note above.
  "origin_deal_id" text,

  "stage" text DEFAULT 'active' NOT NULL,

  -- The term, and where it came from. A won deal carries a value and a close
  -- date and no term, because a term is something the contract says and the
  -- pipeline never asked. `term_source = 'default'` is the platform admitting it
  -- assumed twelve months, so a renewal date built on an assumption is visibly
  -- built on one rather than looking like a fact somebody entered.
  "term_months" integer NOT NULL,
  "term_source" text NOT NULL,

  "contract_value_minor" bigint DEFAULT 0 NOT NULL,
  "currency_code" text NOT NULL,

  "started_at" timestamp NOT NULL,

  -- A date, not a timestamp, and read as UTC midnight everywhere. Contracts
  -- renew on a day rather than at an instant, and the service this replaces
  -- parsed its renewal date at LOCAL midnight -- so the same contract was a day
  -- nearer renewal depending on which region the process happened to run in.
  "renewal_date" date NOT NULL,

  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "customer_lifecycles" ADD CONSTRAINT "chk_customer_lifecycles_stage"
  CHECK ("stage" IN ('active', 'renewal_open', 'at_risk', 'renewed', 'churned'));

--> statement-breakpoint
ALTER TABLE "customer_lifecycles" ADD CONSTRAINT "chk_customer_lifecycles_term"
  CHECK (
    "term_source" IN ('deal', 'tenant', 'default') AND
    "term_months" >= 1 AND "term_months" <= 120 AND
    "contract_value_minor" >= 0
  );

--> statement-breakpoint
ALTER TABLE "customer_lifecycles" ADD CONSTRAINT "fk_customer_lifecycles_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_lifecycles" VALIDATE CONSTRAINT "fk_customer_lifecycles_org";

--> statement-breakpoint
-- CASCADE rather than SET NULL: the tempting SET NULL over a composite key nulls
-- `organization_id` too, which is NOT NULL. Parties are soft-deleted and nothing
-- in `src/` hard-deletes one, so the only path that fires is an organisation
-- being torn down, where removing its contracts is correct.
ALTER TABLE "customer_lifecycles" ADD CONSTRAINT "fk_customer_lifecycles_party"
  FOREIGN KEY ("organization_id", "party_id")
  REFERENCES "business_parties"("organization_id", "party_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_lifecycles" VALIDATE CONSTRAINT "fk_customer_lifecycles_party";

--> statement-breakpoint
-- Ticket 07's third criterion, as a constraint. Leading with organization_id
-- because the RLS predicate is not leakproof and the planner needs it in the
-- index.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_customer_lifecycles_party"
  ON "customer_lifecycles" ("organization_id", "party_id");

--> statement-breakpoint
-- The trigger sweep's read: what renews soonest, tenant by tenant.
CREATE INDEX IF NOT EXISTS "idx_customer_lifecycles_renewal"
  ON "customer_lifecycles" ("organization_id", "renewal_date");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_customer_lifecycles_stage"
  ON "customer_lifecycles" ("organization_id", "stage", "renewal_date");

--> statement-breakpoint
-- The composite tenant key the two child tables point at.
ALTER TABLE "customer_lifecycles" ADD CONSTRAINT "uniq_customer_lifecycles_org_id"
  UNIQUE ("organization_id", "customer_lifecycle_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_lifecycle_signals" (
  "customer_lifecycle_signal_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "customer_lifecycle_id" text NOT NULL,

  -- Denormalised from the lifecycle so a party's signals read without a join.
  -- Kept honest by the composite key above rather than by a writer remembering.
  "party_id" text NOT NULL,

  "kind" text NOT NULL,

  -- Named values, never a sentence. A reason string is unreadable by anything
  -- but a person, and these are what a reviewer disagrees with when they think
  -- the system got it wrong.
  "evidence" jsonb NOT NULL,

  -- The same two words `decision-record.ts` uses. A signal whose class were
  -- named differently here would be classified twice and could disagree with
  -- itself about whether acting on it can be taken back.
  "reversibility" text NOT NULL,
  "summary" text NOT NULL,

  -- When the thing happened, which is not when the sweep noticed it.
  "observed_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "customer_lifecycle_signals" ADD CONSTRAINT "chk_customer_lifecycle_signals_kind"
  CHECK (
    "kind" IN (
      'lifecycle.opened', 'health.dropped', 'health.recovered',
      'health.band-changed', 'renewal.window-opened', 'churn.risk-raised'
    ) AND
    "reversibility" IN ('instant', 'hold') AND
    jsonb_typeof("evidence") = 'object'
  );

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
-- Criterion 4's read: one customer's history, newest first.
CREATE INDEX IF NOT EXISTS "idx_customer_lifecycle_signals_history"
  ON "customer_lifecycle_signals" ("organization_id", "customer_lifecycle_id", "observed_at");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_customer_lifecycle_signals_party"
  ON "customer_lifecycle_signals" ("organization_id", "party_id", "observed_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_health_scores" (
  "customer_health_score_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "party_id" text NOT NULL,

  -- Nullable, because health does not wait for a contract. A customer can be
  -- scored from their timeline and their tickets long before anybody records a
  -- term, and refusing to score them until then would leave the surface empty
  -- for exactly the tenants who have not adopted lifecycles yet.
  "customer_lifecycle_id" text,

  "score" integer NOT NULL,
  "band" text NOT NULL,

  -- Every input, the weight it was given, and whether it had any data at all.
  -- The same idea as a commission entry storing `basis_minor` / `rate_bps` /
  -- `split_bps` rather than the money: the stored thing is what went in, and the
  -- number is derived from it. A composite nobody can take apart is a number
  -- nobody can interrogate, and a number nobody can interrogate is one nobody
  -- acts on.
  "contributions" jsonb NOT NULL,

  -- How much of the declared model had data behind it. 10000 means every input
  -- was measured; 4000 means this is an honest reading of two fifths of it.
  -- This is what makes "a tenant supplying no usage data gets a score computed
  -- from what exists, labelled as such" a stored fact rather than a caveat in a
  -- tooltip -- and it is what stops a change signal firing when an input merely
  -- went quiet, because two scores with different coverage are not comparable.
  "coverage_bps" integer NOT NULL,
  "basis" text NOT NULL,

  "computed_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- `basis` and `coverage_bps` are two spellings of one fact and must never
-- disagree: a row claiming `complete` while reporting partial coverage would
-- make the label a decoration rather than the thing a reader trusts.
ALTER TABLE "customer_health_scores" ADD CONSTRAINT "chk_customer_health_scores_shape"
  CHECK (
    "score" >= 0 AND "score" <= 100 AND
    "band" IN ('healthy', 'at_risk', 'critical') AND
    "coverage_bps" > 0 AND "coverage_bps" <= 10000 AND
    "basis" IN ('complete', 'partial') AND
    (("basis" = 'complete') = ("coverage_bps" >= 10000)) AND
    jsonb_typeof("contributions") = 'array' AND
    jsonb_array_length("contributions") > 0
  );

--> statement-breakpoint
ALTER TABLE "customer_health_scores" ADD CONSTRAINT "fk_customer_health_scores_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_health_scores" VALIDATE CONSTRAINT "fk_customer_health_scores_org";

--> statement-breakpoint
ALTER TABLE "customer_health_scores" ADD CONSTRAINT "fk_customer_health_scores_party"
  FOREIGN KEY ("organization_id", "party_id")
  REFERENCES "business_parties"("organization_id", "party_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_health_scores" VALIDATE CONSTRAINT "fk_customer_health_scores_party";

--> statement-breakpoint
ALTER TABLE "customer_health_scores" ADD CONSTRAINT "fk_customer_health_scores_lifecycle"
  FOREIGN KEY ("organization_id", "customer_lifecycle_id")
  REFERENCES "customer_lifecycles"("organization_id", "customer_lifecycle_id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_health_scores" VALIDATE CONSTRAINT "fk_customer_health_scores_lifecycle";

--> statement-breakpoint
-- The trend read: one customer's scores, newest first.
CREATE INDEX IF NOT EXISTS "idx_customer_health_scores_history"
  ON "customer_health_scores" ("organization_id", "party_id", "computed_at");

--> statement-breakpoint
-- The at-risk sweep: worst band first, for a tenant.
CREATE INDEX IF NOT EXISTS "idx_customer_health_scores_band"
  ON "customer_health_scores" ("organization_id", "band", "computed_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_usage_observations" (
  "customer_usage_observation_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "party_id" text NOT NULL,

  -- The tenant's own name for what they counted -- `weekly_active_seats`.
  "metric_key" text NOT NULL,
  "observed_value" bigint NOT NULL,

  -- What the tenant considers full use of the thing they sold. The denominator
  -- is theirs on purpose: nobody outside the tenant knows what "enough logins"
  -- means for their product, and a platform-chosen benchmark would be the same
  -- lie as a platform-chosen zero.
  "expected_value" bigint NOT NULL,

  "observed_at" timestamp NOT NULL,
  "source" text DEFAULT 'api' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- A zero denominator is not a low score, it is a tenant who told us nothing, and
-- storing one would make every ratio built from it either infinite or invented.
ALTER TABLE "customer_usage_observations" ADD CONSTRAINT "chk_customer_usage_observations_values"
  CHECK ("observed_value" >= 0 AND "expected_value" > 0);

--> statement-breakpoint
ALTER TABLE "customer_usage_observations" ADD CONSTRAINT "fk_customer_usage_observations_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_usage_observations" VALIDATE CONSTRAINT "fk_customer_usage_observations_org";

--> statement-breakpoint
ALTER TABLE "customer_usage_observations" ADD CONSTRAINT "fk_customer_usage_observations_party"
  FOREIGN KEY ("organization_id", "party_id")
  REFERENCES "business_parties"("organization_id", "party_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_usage_observations" VALIDATE CONSTRAINT "fk_customer_usage_observations_party";

--> statement-breakpoint
-- One observation per metric per instant. A tenant re-posting the same period is
-- correcting it, not adding to it -- without this the mean over "the latest
-- observation of each metric" would quietly become a mean over however many
-- times their job retried.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_customer_usage_observations_point"
  ON "customer_usage_observations" ("organization_id", "party_id", "metric_key", "observed_at");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_customer_usage_observations_latest"
  ON "customer_usage_observations" ("organization_id", "party_id", "metric_key", "observed_at");

--> statement-breakpoint
-- The row-level-security matrix, extended to all four.
--
-- Without a policy each is readable organisation-wide, because grants arrive
-- through ALTER DEFAULT PRIVILEGES and a missing policy is silent rather than
-- loud. These hold what a tenant's customers are worth, when their contracts
-- end and how healthy each of them is, which is the most commercially sensitive
-- set of columns this phase produces.
--
-- FORCE as well as ENABLE. Without FORCE the table OWNER bypasses every policy,
-- and the owner is the migration role -- so a cross-tenant read would still be
-- possible from exactly the connection most likely to be used for ad-hoc work.
-- `db-verify-rls.mjs` checks for it by name.
ALTER TABLE "customer_lifecycles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "customer_lifecycles" FORCE ROW LEVEL SECURITY;
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
ALTER TABLE "customer_lifecycle_signals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "customer_lifecycle_signals";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_lifecycle_signals"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "customer_lifecycle_signals" FROM PUBLIC;
--> statement-breakpoint
-- No UPDATE. See the append-only note at the top: a signal history that can be
-- rewritten is a current state with extra rows.
GRANT SELECT, INSERT, DELETE ON "customer_lifecycle_signals" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "customer_health_scores" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "customer_health_scores" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "customer_health_scores";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_health_scores"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "customer_health_scores" FROM PUBLIC;
--> statement-breakpoint
-- No UPDATE, for the same reason. This is the defect the phase inherited.
GRANT SELECT, INSERT, DELETE ON "customer_health_scores" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "customer_usage_observations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "customer_usage_observations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "customer_usage_observations";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_usage_observations"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "customer_usage_observations" FROM PUBLIC;
--> statement-breakpoint
-- UPDATE is granted here and withheld above on purpose: a tenant correcting a
-- telemetry figure they posted is fixing an input, not rewriting a conclusion.
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_usage_observations" TO streamline_app;

--> statement-breakpoint
ANALYZE "customer_lifecycles";
--> statement-breakpoint
ANALYZE "customer_lifecycle_signals";
--> statement-breakpoint
ANALYZE "customer_health_scores";
--> statement-breakpoint
ANALYZE "customer_usage_observations";
