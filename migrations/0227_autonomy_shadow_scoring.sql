-- Custom SQL migration file, put your code below! --

-- Measurement, which with no approval gate IS the safety mechanism.
--
-- Two tables.
--
-- `autonomy_settings` is one row per organisation holding the dials that govern
-- autonomous behaviour. Shadow sampling lives here rather than in an environment
-- variable because a tenant adopting the product cautiously wants more scoring
-- than a tenant who already trusts it, and neither should need a deploy. The
-- hold window lives here too -- ticket 14 needs it, and a second settings table
-- for one adjacent dial would be two places to look.
--
-- `autonomy_shadow_scores` is the second opinion. A sample of live decisions is
-- re-judged by a cheaper pass that never writes anything, and a decision the
-- second pass disagrees with is routed to a review queue even though nobody was
-- required to approve it. That is what turns "we act without asking" into
-- something an operator can defend.
--
-- The daily cap is not a nicety. Scoring is itself inference, so an uncapped
-- sample rate is a bill that scales with how busy the tenant is, and the whole
-- point of the cheap pass is that it stays cheap.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "autonomy_settings" (
  "organization_id" text PRIMARY KEY NOT NULL,
  -- Fraction of decisions given a second opinion. Default 10%: enough to detect
  -- a regression within a day at realistic volumes, cheap enough to leave on.
  "shadow_sample_rate" numeric(4, 3) DEFAULT 0.100 NOT NULL,
  -- Hard stop, so a busy day cannot become an unbounded bill.
  "shadow_daily_cap" integer DEFAULT 500 NOT NULL,
  -- Ticket 14. Seconds an irreversible outbound waits before it leaves.
  "hold_window_seconds" integer DEFAULT 60 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "autonomy_settings" ADD CONSTRAINT "chk_autonomy_settings_sample_rate"
  CHECK ("shadow_sample_rate" >= 0 AND "shadow_sample_rate" <= 1);
--> statement-breakpoint
ALTER TABLE "autonomy_settings" ADD CONSTRAINT "chk_autonomy_settings_daily_cap"
  CHECK ("shadow_daily_cap" >= 0 AND "shadow_daily_cap" <= 100000);
--> statement-breakpoint
-- A zero-second hold is not a hold; it is autonomy with a misleading name. The
-- upper bound stops a tenant from configuring a "hold" nobody will ever see
-- expire, which would silently become an approval queue.
ALTER TABLE "autonomy_settings" ADD CONSTRAINT "chk_autonomy_settings_hold_window"
  CHECK ("hold_window_seconds" >= 10 AND "hold_window_seconds" <= 86400);

--> statement-breakpoint
ALTER TABLE "autonomy_settings" ADD CONSTRAINT "fk_autonomy_settings_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "autonomy_settings" VALIDATE CONSTRAINT "fk_autonomy_settings_org";

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "autonomy_shadow_scores" (
  "autonomy_shadow_score_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "autonomous_decision_id" text NOT NULL,
  "kind" text NOT NULL,
  -- What the second pass concluded about the first.
  "verdict" text NOT NULL,
  "score" double precision,
  "rationale" text,
  "model" text,
  "prompt_version" text,
  -- Routed for a human to look at. Derived from the verdict and the original
  -- confidence together, never accepted from a caller.
  "needs_review" boolean DEFAULT false NOT NULL,
  "reviewed_at" timestamp,
  -- No FK to users: see 0223. A purge would otherwise delete the score row and
  -- shrink the denominator of the very rate this table exists to measure.
  "reviewed_by_user_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "autonomy_shadow_scores" ADD CONSTRAINT "chk_autonomy_shadow_verdict"
  CHECK ("verdict" IN ('agrees', 'disagrees', 'uncertain', 'failed'));
--> statement-breakpoint
ALTER TABLE "autonomy_shadow_scores" ADD CONSTRAINT "chk_autonomy_shadow_score_range"
  CHECK ("score" IS NULL OR ("score" >= 0 AND "score" <= 1));
--> statement-breakpoint
ALTER TABLE "autonomy_shadow_scores" ADD CONSTRAINT "chk_autonomy_shadow_review"
  CHECK (("reviewed_at" IS NULL) = ("reviewed_by_user_id" IS NULL));

--> statement-breakpoint
ALTER TABLE "autonomy_shadow_scores" ADD CONSTRAINT "fk_autonomy_shadow_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "autonomy_shadow_scores" VALIDATE CONSTRAINT "fk_autonomy_shadow_org";

--> statement-breakpoint
ALTER TABLE "autonomy_shadow_scores" ADD CONSTRAINT "fk_autonomy_shadow_decision"
  FOREIGN KEY ("organization_id", "autonomous_decision_id")
  REFERENCES "autonomous_decisions"("organization_id", "autonomous_decision_id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "autonomy_shadow_scores" VALIDATE CONSTRAINT "fk_autonomy_shadow_decision";

--> statement-breakpoint
-- One second opinion per decision. Scoring the same decision twice would let a
-- retry double-count a disagreement and move the scoreboard without any new
-- information.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_autonomy_shadow_decision"
  ON "autonomy_shadow_scores" ("organization_id", "autonomous_decision_id");

--> statement-breakpoint
-- The daily cap counts today's rows for this organisation.
CREATE INDEX IF NOT EXISTS "idx_autonomy_shadow_org_created"
  ON "autonomy_shadow_scores" ("organization_id", "created_at");
--> statement-breakpoint
-- The review queue: what disagreed and nobody has looked at.
CREATE INDEX IF NOT EXISTS "idx_autonomy_shadow_queue"
  ON "autonomy_shadow_scores" ("organization_id", "created_at")
  WHERE "needs_review" = true AND "reviewed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_autonomy_shadow_kind"
  ON "autonomy_shadow_scores" ("organization_id", "kind", "created_at");

--> statement-breakpoint
ALTER TABLE "autonomy_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "autonomy_settings";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "autonomy_settings"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "autonomy_settings" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "autonomy_settings" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "autonomy_shadow_scores" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "autonomy_shadow_scores";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "autonomy_shadow_scores"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "autonomy_shadow_scores" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "autonomy_shadow_scores" TO streamline_app;

--> statement-breakpoint
ANALYZE "autonomy_settings";
--> statement-breakpoint
ANALYZE "autonomy_shadow_scores";
