-- Custom SQL migration file, put your code below! --

-- The interval in which a decision can still be stopped.
--
-- Everything else the system does is instantly reversible, so a mistake costs a
-- click. A message to a customer is not: once it has left the building the only
-- remedy is a second message apologising for the first. The hold is what makes
-- full autonomy survivable on that one class of action -- the system still
-- decides and still acts alone, and there is a short, visible interval in which
-- a human can stop it.
--
-- Nobody clicks approve. They only ever click cancel. That distinction is the
-- whole design: an approval queue that fills up stops the product, while a hold
-- that nobody reads still sends.
--
-- `status` is the concurrency control, not a label. The send path moves
-- `held -> sent` conditionally and checks the affected row, so a cancel landing
-- in the same instant as the window expiring resolves one way or the other and
-- never both. That is what makes "sends exactly once, even across a restart
-- mid-hold" true rather than hoped for.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "autonomy_holds" (
  "autonomy_hold_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "autonomous_decision_id" text NOT NULL,
  "kind" text NOT NULL,
  "status" text DEFAULT 'held' NOT NULL,

  -- An exclusive arc rather than an entity_type/entity_id pair, which is banned
  -- for new tables: no referential integrity and no composite tenant key. Today
  -- only a quote can be held; a second held thing gets its own column and a
  -- widened CHECK.
  "quote_id" integer,

  "hold_until" timestamp NOT NULL,
  "workflow_run_id" text,

  "sent_at" timestamp,
  "cancelled_at" timestamp,
  -- No FK to users: see 0223. Losing the record of who stopped a customer
  -- message because they later left is exactly the wrong trade.
  "cancelled_by_user_id" text,
  "cancel_reason" text,

  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "autonomy_holds" ADD CONSTRAINT "chk_autonomy_holds_status"
  CHECK ("status" IN ('held', 'sent', 'cancelled', 'failed'));

--> statement-breakpoint
ALTER TABLE "autonomy_holds" ADD CONSTRAINT "chk_autonomy_holds_kind"
  CHECK ("kind" IN ('quote.sent'));

--> statement-breakpoint
-- Exactly one target. A hold that points at nothing would wait out its window
-- and then have nothing to send.
ALTER TABLE "autonomy_holds" ADD CONSTRAINT "chk_autonomy_holds_target"
  CHECK ("quote_id" IS NOT NULL);

--> statement-breakpoint
-- Each terminal state carries its own timestamp, and only its own.
ALTER TABLE "autonomy_holds" ADD CONSTRAINT "chk_autonomy_holds_terminal"
  CHECK (
    ("status" = 'held'      AND "sent_at" IS NULL AND "cancelled_at" IS NULL) OR
    ("status" = 'sent'      AND "sent_at" IS NOT NULL AND "cancelled_at" IS NULL) OR
    ("status" = 'cancelled' AND "cancelled_at" IS NOT NULL AND "sent_at" IS NULL) OR
    ("status" = 'failed'    AND "sent_at" IS NULL)
  );

--> statement-breakpoint
ALTER TABLE "autonomy_holds" ADD CONSTRAINT "fk_autonomy_holds_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "autonomy_holds" VALIDATE CONSTRAINT "fk_autonomy_holds_org";

--> statement-breakpoint
ALTER TABLE "autonomy_holds" ADD CONSTRAINT "fk_autonomy_holds_decision"
  FOREIGN KEY ("organization_id", "autonomous_decision_id")
  REFERENCES "autonomous_decisions"("organization_id", "autonomous_decision_id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "autonomy_holds" VALIDATE CONSTRAINT "fk_autonomy_holds_decision";

--> statement-breakpoint
ALTER TABLE "autonomy_holds" ADD CONSTRAINT "fk_autonomy_holds_quote"
  FOREIGN KEY ("organization_id", "quote_id")
  REFERENCES "quotes"("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "autonomy_holds" VALIDATE CONSTRAINT "fk_autonomy_holds_quote";

--> statement-breakpoint
-- One live hold per quote. Two would race each other to send the same document.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_autonomy_holds_live_quote"
  ON "autonomy_holds" ("organization_id", "quote_id")
  WHERE "status" = 'held';

--> statement-breakpoint
-- What is still in flight, soonest first: the review feed's countdown, and what
-- a kill switch has to cancel.
CREATE INDEX IF NOT EXISTS "idx_autonomy_holds_live"
  ON "autonomy_holds" ("organization_id", "hold_until")
  WHERE "status" = 'held';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_autonomy_holds_decision"
  ON "autonomy_holds" ("organization_id", "autonomous_decision_id");

--> statement-breakpoint
ALTER TABLE "autonomy_holds" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "autonomy_holds";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "autonomy_holds"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "autonomy_holds" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "autonomy_holds" TO streamline_app;

--> statement-breakpoint
ANALYZE "autonomy_holds";
