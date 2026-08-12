-- 0429: PIPE-008, PIPE-004, SCH-017 and COMP-005.
--
-- PIPE-008/004  `digestMode` was a stored preference with no runtime effect: a user
--               who chose "daily digest" received nothing at all. Deduplication is
--               also first-write-wins rather than aggregation, so fifteen comments in
--               five minutes produced one notification about comment #1 and silently
--               dropped the rest. Both need somewhere to hold pending items between
--               the event and the send, which is this queue.
--
--               `notification_digest_items` accumulates; `notification_digest_runs`
--               records what was flushed, so a crashed flush is visible and a digest
--               cannot be sent twice for the same window.
--
-- SCH-017       `broadcasts.audience` held roleIds / departmentIds / userIds inside
--               JSONB, so "every broadcast targeting department X" needed a GIN
--               containment query and the ids had no referential integrity. §19 bans
--               JSONB for relational state. The junction table replaces it; the JSONB
--               column stays for now so the read path can be cut over separately
--               (expand-contract — the write is not moved in this step).
--
-- COMP-005      WhatsApp business-initiated messages require a pre-approved template,
--               and a template pending approval cannot be sent. Without modelling the
--               approval state the adapter would discover this at send time, per
--               message, as an opaque provider rejection.

SET statement_timeout = 0;
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "notification_digest_items" (
  "id"              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"          text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id"         text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "channel"         "notification_channel" NOT NULL,
  "event_key"       text NOT NULL,
  "entity_type"     text,
  "entity_id"       text,
  "title"           text NOT NULL,
  "message"         text NOT NULL,
  "link"            text,
  -- PIPE-004: the aggregation key. Repeat events on the same entity collapse onto one
  -- row with a count, instead of the first winning and the rest vanishing.
  "coalesce_key"    text NOT NULL,
  "occurrence_count" integer NOT NULL DEFAULT 1,
  "first_seen_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "deliver_after"   timestamp with time zone NOT NULL,
  "flushed_at"      timestamp with time zone
);
--> statement-breakpoint
-- One open row per (user, channel, coalesce key). Partial so a flushed row does not
-- block the next window from opening its own.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notification_digest_open"
  ON "notification_digest_items" ("org_id","user_id","channel","coalesce_key")
  WHERE "flushed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_digest_due"
  ON "notification_digest_items" ("org_id","deliver_after")
  WHERE "flushed_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notification_digest_items_org_id"
  ON "notification_digest_items" ("org_id","id");
--> statement-breakpoint
ALTER TABLE "notification_digest_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notification_digest_items";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notification_digest_items"
  USING ("org_id" = app.current_org_id()) WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notification_digest_runs" (
  "id"          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"      text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id"     text NOT NULL,
  "channel"     "notification_channel" NOT NULL,
  "window_end"  timestamp with time zone NOT NULL,
  "item_count"  integer NOT NULL,
  "delivery_id" bigint,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- A digest is sent once per user, channel and window — a retried flush is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notification_digest_run_window"
  ON "notification_digest_runs" ("org_id","user_id","channel","window_end");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notification_digest_runs_org_id"
  ON "notification_digest_runs" ("org_id","id");
--> statement-breakpoint
ALTER TABLE "notification_digest_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notification_digest_runs";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notification_digest_runs"
  USING ("org_id" = app.current_org_id()) WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

-- SCH-017
DO $$ BEGIN
  CREATE TYPE "broadcast_audience_kind" AS ENUM ('ROLE','DEPARTMENT','USER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "broadcast_audience_targets" (
  "id"           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"       text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "broadcast_id" integer NOT NULL REFERENCES "broadcasts"("id") ON DELETE cascade,
  "kind"         "broadcast_audience_kind" NOT NULL,
  "target_id"    text NOT NULL,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_broadcast_audience_target"
  ON "broadcast_audience_targets" ("broadcast_id","kind","target_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_broadcast_audience_lookup"
  ON "broadcast_audience_targets" ("org_id","kind","target_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_broadcast_audience_targets_org_id"
  ON "broadcast_audience_targets" ("org_id","id");
--> statement-breakpoint
ALTER TABLE "broadcast_audience_targets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "broadcast_audience_targets";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "broadcast_audience_targets"
  USING ("org_id" = app.current_org_id()) WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

-- COMP-005: approval state on the template row itself, so an unapproved template fails
-- before the provider call rather than as an opaque per-message rejection.
DO $$ BEGIN
  CREATE TYPE "template_approval_status" AS ENUM ('NOT_REQUIRED','PENDING','APPROVED','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "notification_templates"
  ADD COLUMN IF NOT EXISTS "approval_status" "template_approval_status" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN IF NOT EXISTS "provider_template_name" text,
  ADD COLUMN IF NOT EXISTS "approval_checked_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "approval_rejection_reason" text;
