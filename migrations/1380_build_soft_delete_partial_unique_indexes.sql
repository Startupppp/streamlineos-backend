-- 1380 — Build: Convert seven full unique indexes to live-only partial indexes
--
-- Production survey 2026-09-27 (rolled-back READ ONLY transaction):
--   uniq_tickets_project_number          — 14 burned keys (live problem)
--   uniq_project_teams_org_key           — 0 burned keys (preventive)
--   uq_project_risks_project_number      — 0 burned keys (preventive)
--   uq_project_decisions_project_number  — 0 burned keys (preventive)
--   uq_change_requests_project_number    — 0 burned keys (preventive)
--   uq_project_forms_project_number      — 0 burned keys (preventive)
--   uniq_feedbucket_widgets_public_key   — 0 burned keys (preventive)
--
-- Per-index decision rationale:
--
--   project_teams (org_id, key) — team key is a display label; restructuring a team
--   and reassigning its key to a new one is the product use case.  Reuse approved.
--
--   tickets (project_id, ticket_number) — 14 keys burned.  Practical number recycling
--   is still prevented: allocate-ticket-number.ts uses a persistent counter with
--   GREATEST, plus an all-row MAX(ticket_number) scan.  The partial index removes a
--   hard uniqueness violation that cannot be healed by any application action.
--
--   project_risks, project_decisions, change_requests, project_forms — number
--   allocators use COALESCE(MAX(col), 0) + 1 over ALL rows including deleted (see
--   risks.service.ts:155, decisions.service.ts:81, change-requests.service.ts:184,
--   forms.service.ts:108).  Numbers increase monotonically; practical recycling is
--   prevented.  Partial uniqueness removes a hard violation that would otherwise fire
--   if a deleted row were ever restored with an explicit number.
--
--   feedbucket_widgets (public_key) — keys are generated as
--   "fb_" + randomBytes(24).toString("base64url") (feedbucket-widgets.service.ts:49).
--   Collision probability is ~1/2^144, which is negligible in practice.  Furthermore,
--   feedbucket-public.service.ts:15 already filters WHERE deleted_at IS NULL and
--   WHERE is_active = true, so a deleted widget is never resolved; a reissued key
--   would not send new submissions to the old widget's context.  Preventive only.
--
-- Strictly-weaker theorem
-- Going from a full unique index to a partial one restricted to WHERE deleted_at IS
-- NULL is strictly weaker: any two rows that would collide under the old index are
-- both undeleted (a deleted row has no duplicate relationship with a live row under
-- a live-only index).  The new index cannot fail to build on data satisfying the
-- current one.  No pre-migration duplicate survey is needed.
--
-- This migration satisfies both ticket 63 (partial uniqueness for all seven indexes)
-- and ticket 64 (the shared uniq_tickets_project_number index).  It is the single
-- authoritative migration for that index; migration 1381 handles only the NOT NULL
-- constraint for ticket 64 and does not touch any index.
--
-- 3-step swap strategy
-- Each index conversion uses CREATE-under-temp-name / DROP-canonical / RENAME.
-- This means there is never a moment with no uniqueness guard:
--   step 1 (CREATE _new) — both old and new guard exist simultaneously
--   step 2 (DROP canonical) — new guard (_new) remains active
--   step 3 (RENAME _new → canonical) — canonical name restored, partial
--
-- CONCURRENTLY advisory for the tickets table
-- Step 1 for the tickets index (uniq_tickets_project_number_new) can be pre-built
-- outside a transaction using CONCURRENTLY.  The IF NOT EXISTS guard makes step 1
-- here a no-op when that index already exists:
--
--   CREATE UNIQUE INDEX CONCURRENTLY uniq_tickets_project_number_new
--     ON build.tickets (project_id, ticket_number) WHERE deleted_at IS NULL;
--
-- After the manual pre-build, apply this migration as normal.  Steps 2 and 3
-- complete the swap atomically from the application's perspective.
-- All other six tables are small enough that a brief non-concurrent lock is safe.

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

-- ====== 1. project_teams: (org_id, key) — 0 burned, preventive ======

CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_teams_org_key_new
  ON build.project_teams (org_id, key)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS build.uniq_project_teams_org_key;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uniq_project_teams_org_key_new RENAME TO uniq_project_teams_org_key;
--> statement-breakpoint

-- ====== 2. tickets: (project_id, ticket_number) — 14 burned, live problem ======
-- Pre-build step 1 with CONCURRENTLY (see advisory above) before applying.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_tickets_project_number_new
  ON build.tickets (project_id, ticket_number)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS build.uniq_tickets_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uniq_tickets_project_number_new RENAME TO uniq_tickets_project_number;
--> statement-breakpoint

-- ====== 3. project_risks: (project_id, risk_number) — 0 burned, preventive ======

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_risks_project_number_new
  ON build.project_risks (project_id, risk_number)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS build.uq_project_risks_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uq_project_risks_project_number_new RENAME TO uq_project_risks_project_number;
--> statement-breakpoint

-- ====== 4. project_decisions: (project_id, decision_number) — 0 burned, preventive ======

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_decisions_project_number_new
  ON build.project_decisions (project_id, decision_number)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS build.uq_project_decisions_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uq_project_decisions_project_number_new RENAME TO uq_project_decisions_project_number;
--> statement-breakpoint

-- ====== 5. change_requests: (project_id, cr_number) — 0 burned, preventive ======

CREATE UNIQUE INDEX IF NOT EXISTS uq_change_requests_project_number_new
  ON build.change_requests (project_id, cr_number)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS build.uq_change_requests_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uq_change_requests_project_number_new RENAME TO uq_change_requests_project_number;
--> statement-breakpoint

-- ====== 6. project_forms: (project_id, form_number) — 0 burned, preventive ======

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_forms_project_number_new
  ON build.project_forms (project_id, form_number)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS build.uq_project_forms_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uq_project_forms_project_number_new RENAME TO uq_project_forms_project_number;
--> statement-breakpoint

-- ====== 7. feedbucket_widgets: (public_key) — 0 burned, preventive ======

CREATE UNIQUE INDEX IF NOT EXISTS uniq_feedbucket_widgets_public_key_new
  ON build.feedbucket_widgets (public_key)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS build.uniq_feedbucket_widgets_public_key;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uniq_feedbucket_widgets_public_key_new RENAME TO uniq_feedbucket_widgets_public_key;
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

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build' AND indexname = 'uniq_project_teams_org_key_new'
  ), '1380 post-check: temp index uniq_project_teams_org_key_new still exists';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'tickets'
      AND indexname = 'uniq_tickets_project_number'
      AND indexdef LIKE '%deleted_at IS NULL%'
  ), '1380 post-check: uniq_tickets_project_number is not partial';

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build' AND indexname = 'uniq_tickets_project_number_new'
  ), '1380 post-check: temp index uniq_tickets_project_number_new still exists';

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
