-- Custom SQL migration file, put your code below! --

-- What a human changed after the system decided, and why that is worth a table.
--
-- Two things need this and neither can be inferred later. Ticket 15's correction
-- rate needs a correction attributed to the *specific* decision it corrected --
-- counting edits near an action in time would report a rate that is real-looking
-- and wrong. And accuracy only compounds if the correction is captured in a
-- shape an evaluation dataset can take, at the moment the human made it, while
-- the system's own answer is still known.
--
-- `promoted_at` is null until somebody deliberately promotes the row. Promotion
-- is never automatic: a dataset that absorbs every correction absorbs every
-- mistaken correction too, and then the gate measures the noise.
--
-- `consented` gates entry to a dataset at all. Only consented or synthetic data
-- may be promoted, and rows here are within the scope of an erasure request.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "autonomy_corrections" (
  "autonomy_correction_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  -- The decision this corrects. Nullable because a person may correct a
  -- system-set value long after, without going through the feed.
  "autonomous_decision_id" text,
  "kind" text NOT NULL,
  "correction_type" text NOT NULL,
  -- What was corrected, and both answers. Text rather than jsonb: these are
  -- rendered to a person and compared as strings by the eval harness.
  "field" text NOT NULL,
  "system_value" text,
  "human_value" text,
  "reason" text,
  -- No foreign key, deliberately. See 0223: purge-user deletes every row whose
  -- column references `users`, which would silently shrink the denominator of
  -- the correction rate whenever somebody left.
  "corrected_by_user_id" text,
  "consented" boolean DEFAULT false NOT NULL,
  "promoted_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "autonomy_corrections" ADD CONSTRAINT "chk_autonomy_corrections_type"
  CHECK ("correction_type" IN ('reversal', 'edit'));

--> statement-breakpoint
ALTER TABLE "autonomy_corrections" ADD CONSTRAINT "chk_autonomy_corrections_kind"
  CHECK ("kind" IN ('task.extracted', 'stage.advanced', 'party.created', 'activity.logged', 'quote.sent'));

--> statement-breakpoint
-- Promotion requires consent. Enforced here rather than in the promoting code,
-- because the promoting code is exactly what a later ticket will rewrite.
ALTER TABLE "autonomy_corrections" ADD CONSTRAINT "chk_autonomy_corrections_promotion_consented"
  CHECK ("promoted_at" IS NULL OR "consented" = true);

--> statement-breakpoint
ALTER TABLE "autonomy_corrections" ADD CONSTRAINT "fk_autonomy_corrections_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "autonomy_corrections" VALIDATE CONSTRAINT "fk_autonomy_corrections_org";

--> statement-breakpoint
-- The composite tenant key the edge below points at. `autonomous_decisions` has
-- a single-column primary key, and Postgres will not accept a composite foreign
-- key without a unique constraint covering exactly those columns.
ALTER TABLE "autonomous_decisions"
  ADD CONSTRAINT "uniq_autonomous_decisions_org_id"
  UNIQUE ("organization_id", "autonomous_decision_id");

--> statement-breakpoint
-- Composite, so the tenant key is part of the edge rather than an application
-- convention. ON DELETE CASCADE: a correction to a decision that no longer
-- exists cannot be attributed to anything.
ALTER TABLE "autonomy_corrections" ADD CONSTRAINT "fk_autonomy_corrections_decision"
  FOREIGN KEY ("organization_id", "autonomous_decision_id")
  REFERENCES "autonomous_decisions"("organization_id", "autonomous_decision_id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "autonomy_corrections" VALIDATE CONSTRAINT "fk_autonomy_corrections_decision";

--> statement-breakpoint
-- The correction rate, per action type over time.
CREATE INDEX IF NOT EXISTS "idx_autonomy_corrections_kind"
  ON "autonomy_corrections" ("organization_id", "kind", "created_at");
--> statement-breakpoint
-- One decision's corrections, for the feed entry that shows them.
CREATE INDEX IF NOT EXISTS "idx_autonomy_corrections_decision"
  ON "autonomy_corrections" ("organization_id", "autonomous_decision_id");
--> statement-breakpoint
-- What is eligible for promotion and not yet promoted.
CREATE INDEX IF NOT EXISTS "idx_autonomy_corrections_promotable"
  ON "autonomy_corrections" ("organization_id", "created_at")
  WHERE "promoted_at" IS NULL AND "consented" = true;

--> statement-breakpoint
ALTER TABLE "autonomy_corrections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "autonomy_corrections";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "autonomy_corrections"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "autonomy_corrections" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "autonomy_corrections" TO streamline_app;

--> statement-breakpoint
ANALYZE "autonomy_corrections";
