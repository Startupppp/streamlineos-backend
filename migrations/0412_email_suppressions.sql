-- 0412: SEC-002/SEC-003. Neither ZeptoMail nor Resend had a bounce or complaint
-- receiver, so a hard-bounced address was retried on every later send and nothing
-- recorded it. Sender reputation decays until nothing arrives for anyone.
--
-- Keyed on EMAIL, deliberately, not user_id. notification_suppression_rules
-- cascades on user delete, so purging a user resurrects their bounced address — a
-- suppression must outlive the account it came from.
--
-- Two partial uniques rather than one nullable composite: NULL <> NULL in a btree
-- unique, so (org_id, email, channel) with a nullable org_id would enforce nothing
-- for the platform-wide rows. That is the same defect found in SCH-013.
--
-- New enum TYPES rather than ALTER TYPE ... ADD VALUE, so the types and the table
-- that uses them can ship in one migration.

SET statement_timeout = 0;
SET lock_timeout = '5s';

CREATE TYPE "email_suppression_reason" AS ENUM (
  'HARD_BOUNCE', 'COMPLAINT', 'UNSUBSCRIBE', 'MANUAL', 'INVALID_ADDRESS'
);
--> statement-breakpoint
CREATE TYPE "email_suppression_source" AS ENUM (
  'PROVIDER_WEBHOOK', 'USER', 'ADMIN', 'IMPORT'
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "email_suppressions" (
  "id"            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "email"         text NOT NULL,
  "org_id"        text REFERENCES "organizations"("id") ON DELETE cascade,
  "channel"       "notification_channel" NOT NULL DEFAULT 'EMAIL',
  "reason"        "email_suppression_reason" NOT NULL,
  "source"        "email_suppression_source" NOT NULL,
  "evidence"      jsonb,
  "suppressed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"    timestamp with time zone
);
--> statement-breakpoint

-- A hard bounce is a property of the address, not of one tenant: org_id IS NULL
-- means platform-wide. A tenant may additionally suppress an address for itself.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_email_suppressions_global"
  ON "email_suppressions" ("email", "channel") WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_email_suppressions_org"
  ON "email_suppressions" ("org_id", "email", "channel") WHERE "org_id" IS NOT NULL;
--> statement-breakpoint

-- The send-path lookup: one index covering both the global and per-org rows.
CREATE INDEX IF NOT EXISTS "idx_email_suppressions_lookup"
  ON "email_suppressions" ("email", "channel", "expires_at");
