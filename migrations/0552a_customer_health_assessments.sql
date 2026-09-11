-- Custom SQL migration file, put your code below! --

-- Phase 5 ticket 08. A customer health score that decomposes into its inputs.
--
-- This organisation already has a health score and it cannot be argued with.
-- `client_health_scores` stores one integer and a `breakdown` jsonb blob, keyed
-- on `client_account_id`; `health_score_config` stores five weights in another
-- unversioned jsonb blob. Three consequences follow, and these two tables exist
-- to avoid each of them:
--
-- A blob cannot be constrained. `cs-health.service.ts` substitutes
-- `NEUTRAL_BASELINE = 50` for every input it could not measure, so a customer
-- nobody has ever surveyed is stored identically to one whose survey came back
-- exactly neutral. Those are different facts. Here an input is `measured` with a
-- value or `missing` with a reason, and `chk_customer_health_factors_evidence`
-- makes it impossible for a row to be both or neither -- even for a writer that
-- bypasses the service.
--
-- A blob cannot be queried. "Which customers are unscored because nobody
-- records their activity" is the single most actionable question a health model
-- can answer, and it is unanswerable against jsonb without a scan. One row per
-- input makes it an index lookup.
--
-- An unversioned weight table silently restates history. Editing
-- `health_score_config.weights` changes what every stored score meant and
-- nothing records that it happened. `weights_version` is stored on every
-- assessment here so a re-tune is visible rather than retroactive.
--
-- `score` is NULLABLE, and that is the point of the table rather than an
-- oversight: null means the model did not hold enough of its inputs to answer.
-- It is carried out to `business_parties.health_score` -- already nullable, for
-- the same reason -- instead of being rounded into a number somebody would act
-- on.
--
-- `party_id` is the anchor and carries a COMPOSITE tenant foreign key, exactly
-- as `customer_lifecycles.party_id` (0550) does. Not `client_account_id`: that
-- is a legacy identity, and a health score keyed on it gives a merged customer
-- two scores and is invisible to every party-native surface.
--
-- One current assessment per customer, replaced in place. Deliberately not an
-- append-only history: the inputs are read over moving windows against tables
-- that are themselves edited, so a row from March cannot be re-derived and a
-- history of them would be a pile of numbers nobody can check -- which is what
-- `client_health_scores` already is.
--
-- Authored by hand; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_health_assessments" (
  "customer_health_assessment_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,

  -- The customer, as a Party. See the header note on why not client_account_id.
  "party_id" text NOT NULL,

  -- 0..100, or NULL for "not enough inputs to say". Null and zero are different
  -- claims and this column is allowed to make both.
  "score" integer,

  -- `crm_health`, the enum `business_parties.health_status` already holds,
  -- rather than a fourth spelling of the same three states. NULL exactly when
  -- `score` is NULL -- enforced below, because a band on an unscored customer is
  -- a colour on a screen with no number behind it.
  "health_status" "crm_health",

  -- How much of the model's declared weight actually spoke, in basis points.
  -- 68 from a model that had two of its four inputs is not the same claim as 68
  -- from a model that had all four, and a surface without this cannot tell them
  -- apart.
  "coverage_bps" integer NOT NULL,

  -- Which weight table produced this. See the header note.
  "weights_version" integer NOT NULL,

  "computed_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- The score is the band vocabulary's range. A stored 140 would have no band and
-- would render as nothing on every surface that colours by one.
ALTER TABLE "customer_health_assessments" ADD CONSTRAINT "chk_customer_health_assessments_score"
  CHECK ("score" IS NULL OR "score" BETWEEN 0 AND 100);

--> statement-breakpoint
ALTER TABLE "customer_health_assessments" ADD CONSTRAINT "chk_customer_health_assessments_coverage"
  CHECK ("coverage_bps" BETWEEN 0 AND 10000);

--> statement-breakpoint
-- Scored or unscored, never half of each. A band with no score is a colour with
-- nothing behind it; a score with no band is a number no screen can place.
ALTER TABLE "customer_health_assessments" ADD CONSTRAINT "chk_customer_health_assessments_band"
  CHECK (
    ("score" IS NULL AND "health_status" IS NULL) OR
    ("score" IS NOT NULL AND "health_status" IS NOT NULL)
  );

--> statement-breakpoint
ALTER TABLE "customer_health_assessments" ADD CONSTRAINT "fk_customer_health_assessments_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_health_assessments" VALIDATE CONSTRAINT "fk_customer_health_assessments_org";

--> statement-breakpoint
/*
 * The composite foreign key below needs a unique constraint on exactly
 * ("organization_id", "party_id"). 0520 promoted it and 0550 re-asserts it, so
 * this is belt and braces -- but a database built purely by running migrations
 * in order aborts with `42830: there is no unique constraint matching given
 * keys` if it is ever only an index, and a failure there is a failure of the
 * whole run. Idempotent, following 0214, 0520 and 0550.
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
-- CASCADE rather than SET NULL, following 0520 and 0550: SET NULL over a
-- composite key nulls `organization_id` too, which is NOT NULL. Parties are
-- soft-deleted and nothing in `src/` hard-deletes one, so the path that does
-- fire is an organisation being torn down.
ALTER TABLE "customer_health_assessments" ADD CONSTRAINT "fk_customer_health_assessments_party"
  FOREIGN KEY ("organization_id", "party_id")
  REFERENCES "business_parties"("organization_id", "party_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_health_assessments" VALIDATE CONSTRAINT "fk_customer_health_assessments_party";

--> statement-breakpoint
-- One current assessment per customer. This is the upsert's conflict target, so
-- it must exist before the recompute path can run at all -- without it two
-- concurrent recomputes of the same customer both insert and the customer has
-- two scores with two decompositions and no way to say which is current.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_customer_health_assessments_party"
  ON "customer_health_assessments" ("organization_id", "party_id");

--> statement-breakpoint
-- The roster read: worst first. Postgres orders NULLs last under ASC, which is
-- the order this wants -- an unscored customer is an unanswered question rather
-- than the worst answer. Leading with organization_id because the RLS predicate
-- is not leakproof and the planner needs it in the index.
CREATE INDEX IF NOT EXISTS "idx_customer_health_assessments_score"
  ON "customer_health_assessments" ("organization_id", "score");

--> statement-breakpoint
-- The composite tenant key the factor table points at.
ALTER TABLE "customer_health_assessments" ADD CONSTRAINT "uniq_customer_health_assessments_org_id"
  UNIQUE ("organization_id", "customer_health_assessment_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_health_factors" (
  "customer_health_factor_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "customer_health_assessment_id" text NOT NULL,

  -- The question the input answers, never the table it happened to be answered
  -- from. Which table `support` is read out of is a detail of the service.
  "factor_key" text NOT NULL,

  -- What the input is declared to be worth, and what it was actually worth once
  -- the missing inputs' weight was redistributed across the ones that spoke.
  -- Both, because the difference is the interesting part: an input declared at
  -- 2500 that carried 3800 of a particular score is doing more work than the
  -- model says it should, and only the pair says so.
  "weight_bps" integer NOT NULL,
  "effective_weight_bps" integer DEFAULT 0 NOT NULL,

  "status" text NOT NULL,
  -- 0..100. NULL exactly when the input is missing; see the CHECK below.
  "value" integer,
  -- NULL exactly when the input is measured.
  "missing_reason" text,

  -- `value * effective_weight_bps`, so the decomposition reconstructs the score
  -- exactly: score = round(sum(contribution_bps) / 10000). Stored rather than
  -- multiplied on read because rounding is where a decomposition stops adding
  -- up, and a breakdown whose parts do not sum to the whole teaches the reader
  -- the number is approximate when it is not.
  "contribution_bps" integer DEFAULT 0 NOT NULL,

  "observations" integer DEFAULT 0 NOT NULL,

  -- The window is on the row because the inputs do not share one: support and
  -- sentiment are read over six months because tickets and surveys are sparse,
  -- engagement and usage over three because a quarter of silence is already the
  -- answer. Factors reported without their windows invite the reader to assume
  -- they share one.
  "window_days" integer NOT NULL,
  "window_from" timestamp NOT NULL,
  "window_to" timestamp NOT NULL,

  -- The raw counts behind the value -- the layer below the decomposition, and
  -- the level at which an argument about a health score is actually settled.
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,

  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "customer_health_factors" ADD CONSTRAINT "chk_customer_health_factors_key"
  CHECK ("factor_key" IN ('usage', 'engagement', 'support', 'sentiment'));

--> statement-breakpoint
ALTER TABLE "customer_health_factors" ADD CONSTRAINT "chk_customer_health_factors_status"
  CHECK ("status" IN ('measured', 'missing'));

--> statement-breakpoint
-- The invariant the whole ticket rests on, in the database rather than only in
-- the service: a MISSING input has no value and states why it is missing; a
-- MEASURED one has a value and no reason. Without this a writer can file
-- "missing, value 0" or "measured, no value", and either one is the score
-- lying about what it knew -- the same defect as substituting a neutral
-- baseline, arriving from a different direction.
ALTER TABLE "customer_health_factors" ADD CONSTRAINT "chk_customer_health_factors_evidence"
  CHECK (
    ("status" = 'measured' AND "value" IS NOT NULL AND "missing_reason" IS NULL) OR
    ("status" = 'missing' AND "value" IS NULL AND "missing_reason" IS NOT NULL)
  );

--> statement-breakpoint
-- Three reasons, kept apart: no source at all in this organisation, a source in
-- use but nothing ever observed for this customer, and something observed but
-- all of it older than the window. They are fixed by three different actions,
-- which is why collapsing them would make the score's own gaps unactionable.
ALTER TABLE "customer_health_factors" ADD CONSTRAINT "chk_customer_health_factors_reason"
  CHECK ("missing_reason" IS NULL OR "missing_reason" IN ('no-source', 'no-observations', 'stale'));

--> statement-breakpoint
ALTER TABLE "customer_health_factors" ADD CONSTRAINT "chk_customer_health_factors_amounts"
  CHECK (
    "weight_bps" BETWEEN 0 AND 10000 AND
    "effective_weight_bps" BETWEEN 0 AND 10000 AND
    "contribution_bps" >= 0 AND
    "observations" >= 0 AND
    "window_days" > 0 AND
    "window_to" > "window_from" AND
    ("value" IS NULL OR "value" BETWEEN 0 AND 100)
  );

--> statement-breakpoint
-- A missing input carries no weight and adds no points. Stated as a constraint
-- rather than left to the writer because this is exactly the arithmetic that
-- turns "missing" back into "zero" -- a missing factor with a non-zero
-- effective weight would be silently scoring an unmeasured input as 0.
ALTER TABLE "customer_health_factors" ADD CONSTRAINT "chk_customer_health_factors_missing_weightless"
  CHECK (
    "status" = 'measured' OR
    ("effective_weight_bps" = 0 AND "contribution_bps" = 0 AND "observations" = 0)
  );

--> statement-breakpoint
ALTER TABLE "customer_health_factors" ADD CONSTRAINT "fk_customer_health_factors_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_health_factors" VALIDATE CONSTRAINT "fk_customer_health_factors_org";

--> statement-breakpoint
ALTER TABLE "customer_health_factors" ADD CONSTRAINT "fk_customer_health_factors_assessment"
  FOREIGN KEY ("organization_id", "customer_health_assessment_id")
  REFERENCES "customer_health_assessments"("organization_id", "customer_health_assessment_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_health_factors" VALIDATE CONSTRAINT "fk_customer_health_factors_assessment";

--> statement-breakpoint
-- One row per input per assessment -- so a decomposition cannot contain the same
-- input twice with two different values -- and the composite foreign key's own
-- delete-time lookup, which searches the leading pair. One index serves both.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_customer_health_factors_key"
  ON "customer_health_factors" ("organization_id", "customer_health_assessment_id", "factor_key");

--> statement-breakpoint
-- Without a policy each table is readable organisation-wide: grants arrive
-- through ALTER DEFAULT PRIVILEGES, so a missing policy is silent. These say
-- which of a tenant's customers are thought to be leaving, and why -- which is
-- among the most disclosive data in the product.
ALTER TABLE "customer_health_assessments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "customer_health_assessments";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_health_assessments"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "customer_health_assessments" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_health_assessments" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "customer_health_factors" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "customer_health_factors";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_health_factors"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "customer_health_factors" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_health_factors" TO streamline_app;

--> statement-breakpoint
ANALYZE "customer_health_assessments";
--> statement-breakpoint
ANALYZE "customer_health_factors";
