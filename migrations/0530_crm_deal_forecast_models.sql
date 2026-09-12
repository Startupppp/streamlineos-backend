-- Custom SQL migration file, put your code below! --

-- A learned forecast, per tenant, with the evidence for it stored beside it.
--
-- Two tables and two indexes on tables that already exist.
--
-- `crm_deal_forecast_models` holds one organisation's own model. Per tenant
-- rather than global because a global model encodes the average customer's
-- sales process and no customer has that process: a two-week transactional
-- pipeline and a nine-month enterprise one disagree about what a thirty-day-old
-- deal means, and a model fitted across both is wrong for each of them.
--
-- The row carries the whole model -- coefficients, the standardisation they were
-- fitted under, and the covariance the confidence intervals are derived from --
-- rather than a pointer to one held elsewhere. A forecast is a claim about
-- money, and a claim nobody can reproduce months later, after the training deals
-- have closed and moved on, is not a claim anyone should act on.
--
-- `became_available_at` is the moment this organisation first had a learned
-- forecast at all, carried forward unchanged across every retrain. The
-- cold-start surface turns on it: crossing the history threshold has to be
-- something that happened at a time, not a state a screen infers.
--
-- `crm_deal_forecast_scores` holds the current score for each open deal, one row
-- per deal, replaced by the daily pass. `features` sits beside the answer on
-- purpose. Without it a rep who disagrees with a number has nothing to argue
-- with, because the deal has moved by the time they look and recomputing gives a
-- different answer. With it the whole thing is `intercept + sum(w_i * z_i)` over
-- values they can check against the deal in front of them.
--
-- No `entity_type`/`entity_id` pair anywhere: both tables name what they point
-- at, and both foreign keys are composite on `(organization_id, ...)` so tenant
-- integrity is relational rather than a convention the application remembers.
--
-- Authored by hand; see 0205 for why db:generate cannot run in this repository.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_deal_forecast_models" (
  "crm_deal_forecast_model_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  -- The feature vocabulary the coefficients were fitted against. Coefficients
  -- applied to a different vocabulary are numbers with no meaning that still
  -- look like a probability, so a scorer refuses a version it does not match.
  "feature_spec_version" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "trained_at" timestamp DEFAULT now() NOT NULL,
  -- Set once, then carried forward by every retrain.
  "became_available_at" timestamp DEFAULT now() NOT NULL,
  "training_deals" integer NOT NULL,
  "holdout_deals" integer NOT NULL,
  "won_deals" integer NOT NULL,
  "lost_deals" integer NOT NULL,
  "coefficients" jsonb NOT NULL,
  -- The learned model AND the naive weighted forecast, measured on the same
  -- held-out deals. A model that cannot beat the stage probabilities the tenant
  -- typed in themselves has earned nothing, and this is where that is checked.
  "evaluation" jsonb NOT NULL,
  "ridge" double precision NOT NULL,
  "iterations" integer NOT NULL,
  "converged" boolean NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "crm_deal_forecast_models" DROP CONSTRAINT IF EXISTS "chk_crm_deal_forecast_models_status";
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "crm_deal_forecast_models" ADD CONSTRAINT "chk_crm_deal_forecast_models_status"
  CHECK ("status" IN ('active', 'superseded'));
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
-- A model fitted on nothing is not a model. The floor the product enforces is
-- much higher; this only makes the degenerate row unrepresentable.
ALTER TABLE "crm_deal_forecast_models" ADD CONSTRAINT "chk_crm_deal_forecast_models_counts"
  CHECK (
    "training_deals" > 0
    AND "holdout_deals" >= 0
    AND "won_deals" >= 0
    AND "lost_deals" >= 0
  );
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
-- Without a penalty a separable sales history has no finite fit and every
-- probability collapses to 0 or 1, so a stored model with no ridge would be a
-- stored set of infinities.
ALTER TABLE "crm_deal_forecast_models" ADD CONSTRAINT "chk_crm_deal_forecast_models_ridge"
  CHECK ("ridge" > 0);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "crm_deal_forecast_models" ADD CONSTRAINT "fk_crm_deal_forecast_models_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "crm_deal_forecast_models" VALIDATE CONSTRAINT "fk_crm_deal_forecast_models_org";

--> statement-breakpoint
DO $$ BEGIN
-- The tenant key the scores table's composite foreign key targets. A constraint
-- rather than a bare index, so it is a declared referent rather than one the
-- planner happens to accept today.
ALTER TABLE "crm_deal_forecast_models" ADD CONSTRAINT "uniq_crm_deal_forecast_models_org_id"
  UNIQUE ("organization_id", "crm_deal_forecast_model_id");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
-- Exactly one current model per organisation. Partial, because superseded rows
-- are kept: a score written last week names the model that produced it, and
-- deleting the model would make that score unexplainable.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_deal_forecast_models_active"
  ON "crm_deal_forecast_models" ("organization_id")
  WHERE "status" = 'active';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_deal_forecast_models_org_trained"
  ON "crm_deal_forecast_models" ("organization_id", "trained_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_deal_forecast_scores" (
  "crm_deal_forecast_score_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "deal_id" integer NOT NULL,
  "crm_deal_forecast_model_id" text NOT NULL,
  -- The moment the features describe, which is not the moment the row was
  -- written: reproducing a score means knowing what the model was looking at.
  "as_of" timestamp NOT NULL,
  "scored_at" timestamp DEFAULT now() NOT NULL,
  "probability" double precision NOT NULL,
  "interval_lower" double precision NOT NULL,
  "interval_upper" double precision NOT NULL,
  -- Money stays integer minor units, here as elsewhere.
  "expected_value_minor" bigint NOT NULL,
  "features" jsonb NOT NULL,
  "factors" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "crm_deal_forecast_scores" ADD CONSTRAINT "chk_crm_deal_forecast_scores_probability"
  CHECK ("probability" >= 0 AND "probability" <= 1);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
-- The interval has to contain the estimate it is an interval for. A row that
-- fails this is a rendering that shows "62% (71% – 48%)", which reads as a bug
-- in the product rather than in the arithmetic that produced it.
ALTER TABLE "crm_deal_forecast_scores" ADD CONSTRAINT "chk_crm_deal_forecast_scores_interval"
  CHECK (
    "interval_lower" >= 0
    AND "interval_upper" <= 1
    AND "interval_lower" <= "probability"
    AND "probability" <= "interval_upper"
  );
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "crm_deal_forecast_scores" ADD CONSTRAINT "chk_crm_deal_forecast_scores_value"
  CHECK ("expected_value_minor" >= 0);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "crm_deal_forecast_scores" ADD CONSTRAINT "fk_crm_deal_forecast_scores_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "crm_deal_forecast_scores" VALIDATE CONSTRAINT "fk_crm_deal_forecast_scores_org";

--> statement-breakpoint
DO $$ BEGIN
-- Composite on the tenant, so a score can never point at another organisation's
-- deal even if the application forgets to say which organisation it is in.
ALTER TABLE "crm_deal_forecast_scores" ADD CONSTRAINT "fk_crm_deal_forecast_scores_deal"
  FOREIGN KEY ("organization_id", "deal_id")
  REFERENCES "deals"("org_id", "id") ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "crm_deal_forecast_scores" VALIDATE CONSTRAINT "fk_crm_deal_forecast_scores_deal";

--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "crm_deal_forecast_scores" ADD CONSTRAINT "fk_crm_deal_forecast_scores_model"
  FOREIGN KEY ("organization_id", "crm_deal_forecast_model_id")
  REFERENCES "crm_deal_forecast_models"("organization_id", "crm_deal_forecast_model_id")
  ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "crm_deal_forecast_scores" VALIDATE CONSTRAINT "fk_crm_deal_forecast_scores_model";

--> statement-breakpoint
-- One current score per deal. The daily pass upserts on this.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_deal_forecast_scores_deal"
  ON "crm_deal_forecast_scores" ("organization_id", "deal_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_deal_forecast_scores_org_scored"
  ON "crm_deal_forecast_scores" ("organization_id", "scored_at");

--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "crm_deal_forecast_scores" ADD CONSTRAINT "uniq_crm_deal_forecast_scores_org_id"
  UNIQUE ("organization_id", "crm_deal_forecast_score_id");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
--> statement-breakpoint
-- The activity half of feature assembly: count and last timestamp per deal, for
-- every open deal in one grouped pass. `idx_deal_activities_deal` is on
-- `deal_id` alone and `idx_deal_activities_org` on `org_id` alone, so the
-- grouped read over one organisation's deals could use neither for the
-- `created_at` bound and fell back to a scan of the organisation's whole
-- activity history once per pass. Leading with `org_id` is also what lets the
-- index be used at all under row-level security, whose `org_id` qual is not
-- leakproof and is therefore evaluated against the heap tuple.
CREATE INDEX IF NOT EXISTS "idx_deal_activities_org_deal_created"
  ON "deal_activities" ("org_id", "deal_id", "created_at");

--> statement-breakpoint
-- And the training read: this organisation's closed deals, newest first, capped.
-- Terminal stage keys are per-tenant configuration rather than an enum, so the
-- predicate is `stage = ANY(...)` and the close date does the ordering.
CREATE INDEX IF NOT EXISTS "idx_deals_org_stage_closed"
  ON "deals" ("org_id", "stage", "actual_close_date")
  WHERE "deleted_at" IS NULL;

--> statement-breakpoint
ALTER TABLE "crm_deal_forecast_models" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_deal_forecast_models";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_deal_forecast_models"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_deal_forecast_models" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_deal_forecast_models" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "crm_deal_forecast_scores" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_deal_forecast_scores";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_deal_forecast_scores"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_deal_forecast_scores" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_deal_forecast_scores" TO streamline_app;

--> statement-breakpoint
ANALYZE "crm_deal_forecast_models";
--> statement-breakpoint
ANALYZE "crm_deal_forecast_scores";
--> statement-breakpoint
ANALYZE "deal_activities";
--> statement-breakpoint
ANALYZE "deals";
