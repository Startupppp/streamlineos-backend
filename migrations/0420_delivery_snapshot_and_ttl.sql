-- 0420: REG-008 and PIPE-012.
--
-- REG-008  notification_deliveries recorded no rendered content. "What exactly did
--          you send my employee" was unanswerable the moment a template changed —
--          reconstructing from a template that has since been edited is not an
--          answer. The snapshot is what was actually sent, plus the template version
--          it came from.
--
-- PIPE-012  Nothing expired. A queued notification delivered hours late whether or
--           not it was still worth anything, and a backlog turned into a flood of
--           stale messages on recovery. `expires_at` lets the worker drop rather than
--           deliver, recorded as CANCELLED (already an enum member) — nothing failed,
--           it simply stopped being worth sending.
--
-- All four columns are nullable and additive: existing rows keep NULL and behave
-- exactly as before, so this cannot change the behaviour of anything already queued.

SET lock_timeout = '5s';

ALTER TABLE "notification_deliveries"
  ADD COLUMN IF NOT EXISTS "rendered_subject" text,
  ADD COLUMN IF NOT EXISTS "rendered_body"    text,
  ADD COLUMN IF NOT EXISTS "template_version" integer,
  ADD COLUMN IF NOT EXISTS "expires_at"       timestamp with time zone;
--> statement-breakpoint

-- The worker's expiry check: only rows that actually carry a deadline.
CREATE INDEX IF NOT EXISTS "idx_notification_deliveries_expiry"
  ON "notification_deliveries" ("org_id", "expires_at")
  WHERE "expires_at" IS NOT NULL;
