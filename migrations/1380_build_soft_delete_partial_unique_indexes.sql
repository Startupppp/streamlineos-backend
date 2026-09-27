-- 1380 — Build: Restrict seven unique indexes to undeleted rows only
--
-- Without a WHERE predicate these indexes covered deleted rows, so a soft-
-- deleted team keyed PLAT permanently blocked creating a new PLAT team, a
-- soft-deleted widget burned its public key forever (dead embed endpoint), and
-- so on for risk/decision/CR/form numbers.  The correct form already exists for
-- projects: uniq_projects_org_key uses WHERE deleted_at IS NULL (core.ts:79).
-- This migration copies that pattern seven times.
--
-- Going from a full unique index to a partial one is strictly weaker: any two
-- rows that collide under the old index are both undeleted (a deleted row has
-- no duplicate relationship with a live row under a live-only index).  The new
-- index cannot fail to build on data satisfying the current one.  No pre-
-- migration survey is needed.
--
-- This migration satisfies both ticket 63 (partial uniqueness for all seven
-- indexes) and ticket 64 (the shared uniq_tickets_project_number index), which
-- both required changes to that one index.  It is the single authoritative
-- migration for uniq_tickets_project_number; migration 1381 handles only the
-- NOT NULL constraint for ticket 64 and does not touch any index.
--
-- CONCURRENTLY advisory for the tickets table
-- No CONCURRENTLY keyword appears in this file.  build.tickets is the primary
-- work-item table and is likely the largest in the build schema.  Non-concurrent
-- DROP + CREATE takes a brief ShareLock that blocks writes.  For zero-downtime
-- deployment, run the following pair manually outside a transaction before
-- applying this migration — the IF EXISTS / IF NOT EXISTS guards below then
-- make the pair a no-op:
--
--   DROP INDEX CONCURRENTLY build.uniq_tickets_project_number;
--   CREATE UNIQUE INDEX CONCURRENTLY uniq_tickets_project_number
--     ON build.tickets (project_id, ticket_number) WHERE deleted_at IS NULL;
--
-- All other six tables (project_teams, project_risks, project_decisions,
-- change_requests, project_forms, feedbucket_widgets) are judged small enough
-- that a brief non-concurrent lock is acceptable.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.project_teams') IS NULL THEN
    RAISE EXCEPTION '1380 precondition: build.project_teams is absent';
  END IF;
  IF to_regclass('build.tickets') IS NULL THEN
    RAISE EXCEPTION '1380 precondition: build.tickets is absent';
  END IF;
  IF to_regclass('build.project_risks') IS NULL THEN
    RAISE EXCEPTION '1380 precondition: build.project_risks is absent';
  END IF;
  IF to_regclass('build.project_decisions') IS NULL THEN
    RAISE EXCEPTION '1380 precondition: build.project_decisions is absent';
  END IF;
  IF to_regclass('build.change_requests') IS NULL THEN
    RAISE EXCEPTION '1380 precondition: build.change_requests is absent';
  END IF;
  IF to_regclass('build.project_forms') IS NULL THEN
    RAISE EXCEPTION '1380 precondition: build.project_forms is absent';
  END IF;
  IF to_regclass('build.feedbucket_widgets') IS NULL THEN
    RAISE EXCEPTION '1380 precondition: build.feedbucket_widgets is absent';
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS build.uniq_project_teams_org_key;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_teams_org_key
  ON build.project_teams (org_id, key)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS build.uniq_tickets_project_number;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tickets_project_number
  ON build.tickets (project_id, ticket_number)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS build.uq_project_risks_project_number;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_risks_project_number
  ON build.project_risks (project_id, risk_number)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS build.uq_project_decisions_project_number;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_decisions_project_number
  ON build.project_decisions (project_id, decision_number)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS build.uq_change_requests_project_number;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_change_requests_project_number
  ON build.change_requests (project_id, cr_number)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS build.uq_project_forms_project_number;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_forms_project_number
  ON build.project_forms (project_id, form_number)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS build.uniq_feedbucket_widgets_public_key;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_feedbucket_widgets_public_key
  ON build.feedbucket_widgets (public_key)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'project_teams'
      AND indexname = 'uniq_project_teams_org_key'
      AND indexdef LIKE '%deleted_at IS NULL%'
  ), '1380 post-check: uniq_project_teams_org_key is not partial';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'tickets'
      AND indexname = 'uniq_tickets_project_number'
      AND indexdef LIKE '%deleted_at IS NULL%'
  ), '1380 post-check: uniq_tickets_project_number is not partial';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'project_risks'
      AND indexname = 'uq_project_risks_project_number'
      AND indexdef LIKE '%deleted_at IS NULL%'
  ), '1380 post-check: uq_project_risks_project_number is not partial';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'project_decisions'
      AND indexname = 'uq_project_decisions_project_number'
      AND indexdef LIKE '%deleted_at IS NULL%'
  ), '1380 post-check: uq_project_decisions_project_number is not partial';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'change_requests'
      AND indexname = 'uq_change_requests_project_number'
      AND indexdef LIKE '%deleted_at IS NULL%'
  ), '1380 post-check: uq_change_requests_project_number is not partial';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'project_forms'
      AND indexname = 'uq_project_forms_project_number'
      AND indexdef LIKE '%deleted_at IS NULL%'
  ), '1380 post-check: uq_project_forms_project_number is not partial';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'feedbucket_widgets'
      AND indexname = 'uniq_feedbucket_widgets_public_key'
      AND indexdef LIKE '%deleted_at IS NULL%'
  ), '1380 post-check: uniq_feedbucket_widgets_public_key is not partial';
END $$;
