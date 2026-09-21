-- Timesheet approval routing: which person a submitted period is waiting on,
-- why they were chosen, when a decision is due, and whether the SLA sweep has
-- already moved it up the chain. The organisation also chooses whether the
-- reporting manager (the default) or the dominant project's manager approves.
SET lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'timesheet_approver_source') THEN
    CREATE TYPE "public"."timesheet_approver_source" AS ENUM ('REPORTING_MANAGER', 'PROJECT_MANAGER');
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "timesheet_settings"
  ADD COLUMN IF NOT EXISTS "approver_source" "timesheet_approver_source" NOT NULL DEFAULT 'REPORTING_MANAGER';
--> statement-breakpoint
ALTER TABLE "timesheet_periods"
  ADD COLUMN IF NOT EXISTS "approval_route" jsonb,
  ADD COLUMN IF NOT EXISTS "approval_due_at" timestamp,
  ADD COLUMN IF NOT EXISTS "approval_escalated_at" timestamp;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timesheet_periods_org_awaiting_decision"
  ON "timesheet_periods" ("org_id", "approval_due_at")
  WHERE "status" = 'SUBMITTED';
