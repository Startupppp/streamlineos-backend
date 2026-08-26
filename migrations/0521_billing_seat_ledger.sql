-- 0521 — c26: Billing seat event ledger
--
-- Append-only log of every billable seat change: invitation sent/accepted/expired/
-- cancelled, member suspended/reactivated/deactivated, guest added/removed. Each
-- row records the quantity delta and the total billed quantity immediately after the
-- triggering membership write (read from the live seatCount() expression, inside the
-- same transaction, so the ledger and the enforcement gate agree).
--
-- The table is immutable after insert; reconciliation queries sum quantity_delta to
-- reconstruct the current billed count from first principles.
--
-- Operator notes — indexes
-- ────────────────────────
-- CREATE INDEX runs inside the migration transaction. On a large table, run
-- CONCURRENTLY by hand before applying and the IF NOT EXISTS guards make the
-- in-transaction forms a no-op:
--
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_billing_seat_events_idem"
--     ON "billing_seat_events" ("org_id", "idempotency_key")
--     WHERE idempotency_key IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_seat_events_org_time"
--     ON "billing_seat_events" ("org_id", "effective_at" DESC);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_seat_events_org_subject"
--     ON "billing_seat_events" ("org_id", "subject_id");

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE "billing_seat_events" (
  "id"                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"               text NOT NULL,
  "event_type"           varchar(30) NOT NULL,
  "subject_id"           text NOT NULL,
  "actor_id"             text,
  "reason"               text,
  "idempotency_key"      varchar(120),
  "effective_at"         timestamp NOT NULL,
  "quantity_delta"       integer NOT NULL,
  "billed_quantity_after" integer NOT NULL,
  "metadata"             jsonb,
  "created_at"           timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_billing_seat_events_org_id" UNIQUE ("org_id", "id")
);

--> statement-breakpoint
ALTER TABLE "billing_seat_events"
  ADD CONSTRAINT "billing_seat_events_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_seat_events"
  VALIDATE CONSTRAINT "billing_seat_events_org_id_organizations_id_fk";

--> statement-breakpoint
ALTER TABLE "billing_seat_events"
  ADD CONSTRAINT "billing_seat_events_actor_id_users_id_fk"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_seat_events"
  VALIDATE CONSTRAINT "billing_seat_events_actor_id_users_id_fk";

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_billing_seat_events_idem"
  ON "billing_seat_events" ("org_id", "idempotency_key")
  WHERE idempotency_key IS NOT NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_seat_events_org_time"
  ON "billing_seat_events" ("org_id", "effective_at" DESC);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_seat_events_org_subject"
  ON "billing_seat_events" ("org_id", "subject_id");

--> statement-breakpoint
ALTER TABLE "billing_seat_events" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "billing_seat_events";

--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_seat_events"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

--> statement-breakpoint
REVOKE ALL ON "billing_seat_events" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_seat_events" TO streamline_app;
