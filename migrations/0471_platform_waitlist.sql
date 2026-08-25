-- The landing page no longer offers sign-in or sign-up; the only way in is to
-- ask for one. That request has to survive the email that announces it, or a
-- provider outage silently loses a signup we can never reconstruct — so the row
-- is written first and the notification is best-effort on top of it.
--
-- Platform-level like `platform_messages`: a waitlist entry predates any
-- organisation, so it carries no `org_id`, no tenant FK and no RLS policy. It is
-- reachable only through the owner surface and the @Public() write path.
--
-- Hand-authored for the reason given in 0464: `migrations/meta` snapshots stop
-- at 0231, so `drizzle-kit generate` is unusable in this repo.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_waitlist" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_code" text NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "organization" text,
  "role" text,
  "team_size" text,
  "notes" text,
  "status" text DEFAULT 'PENDING' NOT NULL,
  "invited_at" timestamp,
  "ip_address" text,
  "user_agent" text,
  "referrer_url" text,
  "utm" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "platform_waitlist_public_code_unique" UNIQUE("public_code")
);
--> statement-breakpoint
-- One row per person. A second submission from the same address is the same
-- request restated, and the service upserts onto this index rather than
-- reporting a conflict the visitor cannot act on.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_platform_waitlist_email"
  ON "platform_waitlist" ("email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_waitlist_status"
  ON "platform_waitlist" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_waitlist_created"
  ON "platform_waitlist" ("created_at");
