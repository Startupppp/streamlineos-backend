-- A mock e-invoice transport gets its own member of `compliance_transport`, so
-- a row written by it can never be read as a real filing.
--
-- Hand-authored for the reason given in 0464: `migrations/meta` snapshots stop
-- at 0231, so `drizzle-kit generate` is unusable in this repo.
--
-- WHY A NEW ENUM MEMBER RATHER THAN A FLAG OR A COLUMN. The alternative is to
-- record `transport = 'irp'` and remember, somewhere else, that this
-- deployment was running a mock at the time. That memory does not survive: an
-- environment variable changes, a database is restored into a different
-- deployment, a row is copied into a report. `document_compliance` rows are
-- kept as evidence that a statutory obligation was met, and evidence has to
-- carry its own provenance. `mock_irp` is legible forever, in a query, in a
-- CSV export and in a screenshot, with nothing else present.
--
-- `ADD VALUE` is safe inside a transaction on PG12+, but the new label cannot
-- be USED until that transaction commits. Nothing here writes a compliance row.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TYPE "public"."compliance_transport" ADD VALUE IF NOT EXISTS 'mock_irp' AFTER 'irp';
