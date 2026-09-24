-- Rollback for migration 1165.
--
-- Drops the automation run/action history tables and their enum types.
--
-- @data-loss: build.project_automation_runs, build.project_automation_run_actions
-- All recorded automation run history (success/failure/loop-guard/rate-limit
-- outcomes and per-action results) is lost. The automation rules themselves
-- (build.project_automations) are untouched — only the audit trail of their
-- executions is removed.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP TABLE IF EXISTS "build"."project_automation_run_actions";
--> statement-breakpoint
DROP TABLE IF EXISTS "build"."project_automation_runs";
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
      JOIN pg_type t ON t.oid = a.atttypid
     WHERE t.typname = 'automation_action_outcome' AND NOT a.attisdropped
  ) THEN
    DROP TYPE IF EXISTS "public"."automation_action_outcome";
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
      JOIN pg_type t ON t.oid = a.atttypid
     WHERE t.typname = 'automation_run_outcome' AND NOT a.attisdropped
  ) THEN
    DROP TYPE IF EXISTS "public"."automation_run_outcome";
  END IF;
END $$;
