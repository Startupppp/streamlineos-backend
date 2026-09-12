-- Custom SQL migration file, put your code below! --

-- Who else processes our customers' data, and what for.
--
-- Phase 3 ticket 16. A register, not a document: a PDF on a website goes stale
-- the week after it is written and the customer whose own compliance depends on
-- it has no way to know.
--
-- Deliberately NOT tenant-scoped, and therefore deliberately without a
-- row-level-security policy. Our subprocessors are the same for every customer;
-- a per-tenant register would imply each organisation has its own set, which is
-- untrue and a strange thing to assert to a regulator. It is platform data,
-- readable by anyone, written by platform staff.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subprocessors" (
  "subprocessor_id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "purpose" text NOT NULL,
  "location" text NOT NULL,
  "url" text,
  -- When they started processing, which is not when the row was written. A
  -- register backfilled today would otherwise claim every subprocessor began
  -- today, making the change history a lie about what happened when.
  "effective_from" timestamp DEFAULT now() NOT NULL,
  -- Retired rows stay. A customer reviewing a past period needs to know who
  -- processed their data then, and deleting the row erases exactly that.
  "retired_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "updated_by" text
);

--> statement-breakpoint
ALTER TABLE "subprocessors" ADD CONSTRAINT "fk_subprocessors_updated_by"
  FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "subprocessors" VALIDATE CONSTRAINT "fk_subprocessors_updated_by";

--> statement-breakpoint
-- One row per named processor: two would put the register in the position of
-- saying two different things about the same company.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_subprocessors_name" ON "subprocessors" ("name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subprocessors_effective"
  ON "subprocessors" ("effective_from");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subprocessor_subscribers" (
  "subprocessor_subscriber_id" text PRIMARY KEY NOT NULL,
  -- An email rather than a user: the person who reviews subprocessors is often
  -- counsel or a compliance officer with no login here, and requiring one would
  -- make the notification useless to exactly the people it exists for.
  "email" text NOT NULL,
  "organization_id" text,
  -- Stamped rather than deleted, so a re-subscribe is one act and unsubscribing
  -- keeps working -- two rows for one address is how it stops.
  "unsubscribed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_subprocessor_subscribers_email"
  ON "subprocessor_subscribers" ("email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subprocessor_subscribers_active"
  ON "subprocessor_subscribers" ("unsubscribed_at");

--> statement-breakpoint
REVOKE ALL ON "subprocessors" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "subprocessors" TO streamline_app;
--> statement-breakpoint
REVOKE ALL ON "subprocessor_subscribers" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "subprocessor_subscribers" TO streamline_app;

--> statement-breakpoint
ANALYZE "subprocessors";
--> statement-breakpoint
ANALYZE "subprocessor_subscribers";
