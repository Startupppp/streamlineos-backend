-- 0419: PIPE-001. Delivery intent was not durable.
--
-- `dispatch.emit()` defers the work with `registerAfterCommit`, which is an array on
-- an AsyncLocalStorage store. A crash between COMMIT and the hook draining loses the
-- notification with no record that it was ever owed — and the failure is invisible,
-- because the business transaction succeeded.
--
-- This table is written INSIDE the caller's transaction, so the domain change and the
-- intent to notify commit together or not at all. A relay drains it afterwards.
--
-- Deliberately NOT reusing common/outbox `outbox_events`: that table carries
-- aggregate_version with a unique on (org, aggregate_type, aggregate_id, version),
-- which a notification intent has no meaningful value for, and its publisher is a
-- broker seam that should stay free for real domain events.
--
-- target_user_ids and variables are jsonb on purpose and this is NOT the §19 array
-- anti-pattern: they are an immutable copy of the call's arguments, never queried,
-- joined, or updated. The relational state is notification_deliveries, one row per
-- recipient per channel, written by the relay.

SET statement_timeout = 0;
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "notification_outbox" (
  "id"               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"           text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "event_key"        text NOT NULL,
  "dedupe_key"       text NOT NULL,
  "actor_user_id"    text,
  "notify_self"      boolean NOT NULL DEFAULT false,
  "target_user_ids"  jsonb NOT NULL,
  "entity_type"      text,
  "entity_id"        text,
  "title"            text,
  "message"          text,
  "link"             text,
  "variables"        jsonb NOT NULL DEFAULT '{}'::jsonb,
  "metadata"         jsonb,
  "state"            text NOT NULL DEFAULT 'PENDING',
  "attempt_count"    integer NOT NULL DEFAULT 0,
  "lease_expires_at" timestamp with time zone,
  "last_error"       text,
  "occurred_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "processed_at"     timestamp with time zone,
  "created_at"       timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notification_outbox_org_id"
  ON "notification_outbox" ("org_id", "id");
--> statement-breakpoint

-- A retried request must not enqueue the same intent twice.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notification_outbox_dedupe"
  ON "notification_outbox" ("org_id", "dedupe_key");
--> statement-breakpoint

-- The relay's claim predicate. Partial so processed rows stop costing anything.
CREATE INDEX IF NOT EXISTS "idx_notification_outbox_claim"
  ON "notification_outbox" ("state", "lease_expires_at", "id")
  WHERE "state" IN ('PENDING', 'IN_FLIGHT');
--> statement-breakpoint

ALTER TABLE "notification_outbox" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS "tenant_isolation" ON "notification_outbox";
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "notification_outbox"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
