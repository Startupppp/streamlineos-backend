-- Custom SQL migration file, put your code below! --

-- Ticket 12. Everything the system decided on its own, and why.
--
-- Because nothing asks for approval, this table IS the oversight mechanism:
-- ticket 13's review feed is a reading of it and ticket 15's scoreboard is a
-- counting of it. A decision written without a row here is an action nobody can
-- review, which is worse than the action not happening.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "autonomous_decisions" (
  "autonomous_decision_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "kind" text NOT NULL,
  "outcome" text NOT NULL,
  "trigger_type" text NOT NULL,
  "trigger_id" text,
  "party_id" text,
  "deal_id" text,
  "activity_id" text,
  "model" text,
  "prompt_version" text,
  "confidence" double precision,
  "inputs" jsonb,
  "decision" jsonb,
  "summary" text,
  "reversibility" text NOT NULL,
  "reversed_at" timestamp,
  "reversed_by_user_id" text,
  "reversed_reason" text,
  "decided_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "autonomous_decisions" ADD CONSTRAINT "chk_autonomous_decisions_kind"
  CHECK ("kind" IN ('task.extracted', 'stage.advanced', 'party.created', 'activity.logged', 'quote.sent'));

--> statement-breakpoint
ALTER TABLE "autonomous_decisions" ADD CONSTRAINT "chk_autonomous_decisions_outcome"
  CHECK ("outcome" IN ('applied', 'held', 'skipped', 'reversed', 'failed'));

--> statement-breakpoint
-- Reversibility is derived from the kind in code; the database refuses anything
-- outside the three classes so a reviewer is never promised an undo that does
-- not exist.
ALTER TABLE "autonomous_decisions" ADD CONSTRAINT "chk_autonomous_decisions_reversibility"
  CHECK ("reversibility" IN ('instant', 'hold', 'irreversible'));

--> statement-breakpoint
-- Confidence is a probability or it is absent. A decision recorded at 4.2 would
-- silently pass every threshold in the scoreboard.
ALTER TABLE "autonomous_decisions" ADD CONSTRAINT "chk_autonomous_decisions_confidence"
  CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));

--> statement-breakpoint
-- A reversal is a person and a moment together, or neither.
ALTER TABLE "autonomous_decisions" ADD CONSTRAINT "chk_autonomous_decisions_reversal"
  CHECK (("reversed_at" IS NULL) = ("reversed_by_user_id" IS NULL));

--> statement-breakpoint
ALTER TABLE "autonomous_decisions" ADD CONSTRAINT "fk_autonomous_decisions_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "autonomous_decisions" VALIDATE CONSTRAINT "fk_autonomous_decisions_org";

--> statement-breakpoint
ALTER TABLE "autonomous_decisions" ADD CONSTRAINT "fk_autonomous_decisions_reverser"
  FOREIGN KEY ("reversed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "autonomous_decisions" VALIDATE CONSTRAINT "fk_autonomous_decisions_reverser";

--> statement-breakpoint
-- The review feed: everything, newest first.
CREATE INDEX IF NOT EXISTS "idx_autonomous_decisions_feed"
  ON "autonomous_decisions" ("organization_id", "decided_at");
--> statement-breakpoint
-- The scoreboard: accuracy per action type over time.
CREATE INDEX IF NOT EXISTS "idx_autonomous_decisions_kind"
  ON "autonomous_decisions" ("organization_id", "kind", "decided_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_autonomous_decisions_reversed"
  ON "autonomous_decisions" ("organization_id", "reversed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_autonomous_decisions_deal"
  ON "autonomous_decisions" ("organization_id", "deal_id", "decided_at");

--> statement-breakpoint
ALTER TABLE "autonomous_decisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "autonomous_decisions";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "autonomous_decisions"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "autonomous_decisions" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "autonomous_decisions" TO streamline_app;

--> statement-breakpoint
ANALYZE "autonomous_decisions";
