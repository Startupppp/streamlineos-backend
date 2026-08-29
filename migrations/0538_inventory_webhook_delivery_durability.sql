-- 0538 — E7. Durable outbound inventory webhooks: retry state, dead-letter
-- marker, and the endpoint health that drives alert-before-auto-disable.
--
-- Context. A5 established that inventory webhooks had never fired: the emitter
-- was called from nowhere and no outbox consumer was registered. Delivery works
-- now, and it works with one attempt and no memory — a subscriber that is
-- restarting loses the event permanently, and nothing anywhere says so. These
-- columns are the state that makes a delivery retryable, terminable, and
-- attributable to an endpoint whose health can be judged.
--
-- Shape notes:
--   * every column is nullable or defaulted, so no table rewrite and no
--     ACCESS EXCLUSIVE beyond the catalog update itself;
--   * `lock_timeout` is set so this fails fast rather than queueing behind a
--     long read and blocking every write to the table behind it (§3 Migrations);
--   * no CONCURRENTLY: drizzle wraps all pending migrations in one transaction,
--     which forbids it. The indexes below are partial and these tables are small
--     (inv_webhook_events is in the low thousands), so the plain form is a
--     sub-second SHARE lock rather than the outage it would be on the ledger;
--   * no `ALTER TYPE inv_webhook_event_status ADD VALUE 'DEAD'`. A new label
--     cannot be *used* in the transaction that adds it, and the enum is also the
--     frontend's status union. Dead-lettered is `dead_lettered_at is not null`.
--
-- Applied to the shared database ahead of this file, one statement per
-- transaction, because 0537 was still pending from another lane and
-- `db:migrate` would have carried it along. Every statement here is guarded —
-- `IF NOT EXISTS` on the DDL, `dead_lettered_at IS NULL` on the backfill — so
-- the run that records this migration in the Drizzle journal is a no-op, and a
-- cold rebuild from an empty database produces the same schema.

SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- inv_webhook_events — per-delivery retry state
-- ---------------------------------------------------------------------------

-- The producing outbox event id. Dispatch is at-least-once (the publisher marks
-- the outbox row DELIVERED in a different transaction from the one that ran the
-- consumer), so a crash between the two replays the emit; unique per
-- (org, webhook) this turns the replay into a no-op instead of a second webhook.
ALTER TABLE "inv_webhook_events" ADD COLUMN IF NOT EXISTS "dedupe_key" text;

-- When the next attempt is due. NULL means no attempt is scheduled: the row is
-- either delivered or terminal.
ALTER TABLE "inv_webhook_events" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp;

-- Worker claim fence. A write-back only applies while this still matches what the
-- claiming worker stamped, so two overlapping ticks cannot both record an attempt.
ALTER TABLE "inv_webhook_events" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp;

ALTER TABLE "inv_webhook_events" ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp;
ALTER TABLE "inv_webhook_events" ADD COLUMN IF NOT EXISTS "last_error" text;
ALTER TABLE "inv_webhook_events" ADD COLUMN IF NOT EXISTS "dead_lettered_at" timestamp;

-- Rows that predate this migration have no schedule and must not suddenly become
-- claimable: leaving next_attempt_at NULL is what keeps the worker from
-- re-delivering historical events the moment it starts. Failures from the old
-- single-attempt emitter are terminal by definition — there was never going to be
-- a second attempt — so they are stamped as dead-lettered, which is what puts
-- them in the dead-letter list where somebody can act on them.
UPDATE "inv_webhook_events"
   SET "dead_lettered_at" = "created_at",
       "last_error" = coalesce("last_error", 'single-attempt-emitter')
 WHERE "status" = 'FAILED'
   AND "dead_lettered_at" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_whe_org_webhook_dedupe"
  ON "inv_webhook_events" ("org_id", "webhook_id", "dedupe_key")
  WHERE "dedupe_key" IS NOT NULL;

-- The claim predicate, most-selective-first behind the tenant key.
CREATE INDEX IF NOT EXISTS "idx_inv_whe_due"
  ON "inv_webhook_events" ("org_id", "next_attempt_at")
  WHERE "status" = 'PENDING';

CREATE INDEX IF NOT EXISTS "idx_inv_whe_dead"
  ON "inv_webhook_events" ("org_id", "dead_lettered_at")
  WHERE "dead_lettered_at" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- inv_webhooks — endpoint health
-- ---------------------------------------------------------------------------

-- Counted in dead-lettered events, not failed attempts: one dead letter already
-- means this URL refused every attempt over the full retry window, so counting
-- attempts would disable a subscriber over a single bad afternoon.
ALTER TABLE "inv_webhooks" ADD COLUMN IF NOT EXISTS "consecutive_failures" integer DEFAULT 0 NOT NULL;
ALTER TABLE "inv_webhooks" ADD COLUMN IF NOT EXISTS "failing_since" timestamp;

-- Stamped when the admin alert is raised. The disable threshold is strictly
-- higher than the alert threshold, so a disabled webhook always has this set —
-- "alert before disable" is a property of the data, not of statement order.
ALTER TABLE "inv_webhooks" ADD COLUMN IF NOT EXISTS "alerted_at" timestamp;

ALTER TABLE "inv_webhooks" ADD COLUMN IF NOT EXISTS "disabled_at" timestamp;
ALTER TABLE "inv_webhooks" ADD COLUMN IF NOT EXISTS "disabled_reason" text;
