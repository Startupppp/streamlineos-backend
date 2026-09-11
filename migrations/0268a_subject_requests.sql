-- Custom SQL migration file, put your code below! --

-- What was done for a data subject, per region, and when.
--
-- Phase 3 tickets 17 and 18. A right that cannot be evidenced was not exercised:
-- this is the record a regulator reads.
--
-- Not tenant-scoped, and therefore no RLS policy. A data subject may exist in
-- several organisations and has one right across all of them; filing the record
-- under one tenant would make the others invisible to the person exercising it.
--
-- Outside the soft-delete default on purpose. Erasure is one of the enumerated
-- exceptions to it, and a soft-deleted erasure record would be a contradiction.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subject_requests" (
  "subject_request_id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "subject_email" text NOT NULL,
  -- One entry per region, verbatim. The summary is derivable from these and they
  -- are not derivable from it, and the per-region detail is what gets asked for.
  "region_outcomes" jsonb,
  "is_complete" text NOT NULL,
  "total_records_affected" integer DEFAULT 0 NOT NULL,
  "backups_expire_by" text,
  "due_by" timestamp,
  "requested_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subject_requests_email"
  ON "subject_requests" ("subject_email", "requested_at");
--> statement-breakpoint
-- The overdue query: anything not yet complete, oldest first.
CREATE INDEX IF NOT EXISTS "idx_subject_requests_due" ON "subject_requests" ("due_by");

--> statement-breakpoint
REVOKE ALL ON "subject_requests" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "subject_requests" TO streamline_app;

--> statement-breakpoint
ANALYZE "subject_requests";
