-- 0433: Public landing waitlist signups.
-- Platform-level (not tenant-scoped): rows are created by anonymous visitors
-- before any organization exists, so there is no org_id and no RLS policy —
-- same shape as platform_messages / platform_visits.
--
-- The unique index on email is what makes the public endpoint idempotent:
-- the service normalizes to trimmed lowercase and inserts with
-- ON CONFLICT DO NOTHING, so a repeat signup is a no-op and the response
-- never reveals whether the address was already on the list.

SET statement_timeout = 0;
SET lock_timeout = '5s';

CREATE TABLE "platform_waitlist_signups" (
  "id"         serial    PRIMARY KEY,
  "email"      text      NOT NULL,
  "name"       text      NOT NULL,
  "company"    text,
  "team_size"  text,
  "source"     text      NOT NULL DEFAULT 'landing',
  "status"     text      NOT NULL DEFAULT 'PENDING',
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_platform_waitlist_signups_email"
  ON "platform_waitlist_signups" ("email");
--> statement-breakpoint

CREATE INDEX "idx_platform_waitlist_signups_status"
  ON "platform_waitlist_signups" ("status");
--> statement-breakpoint

CREATE INDEX "idx_platform_waitlist_signups_source"
  ON "platform_waitlist_signups" ("source");
--> statement-breakpoint

CREATE INDEX "idx_platform_waitlist_signups_created"
  ON "platform_waitlist_signups" ("created_at");
