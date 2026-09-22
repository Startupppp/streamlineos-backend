-- Rollback for migration 1136.
--
-- Destroys data: approval_route holds the resolved approver chain for each
-- period, and approval_due_at / approval_escalated_at hold the SLA stamps. None
-- of it is reconstructible after the drop — the chain was resolved from
-- reporting lines as they stood when the period was submitted.
--
-- The columns go before the type: timesheet_settings.approver_source is the only
-- user of timesheet_approver_source, and DROP TYPE refuses while a column still
-- carries it.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_timesheet_periods_org_awaiting_decision";
--> statement-breakpoint
ALTER TABLE "timesheet_periods" DROP COLUMN IF EXISTS "approval_escalated_at";
--> statement-breakpoint
ALTER TABLE "timesheet_periods" DROP COLUMN IF EXISTS "approval_due_at";
--> statement-breakpoint
ALTER TABLE "timesheet_periods" DROP COLUMN IF EXISTS "approval_route";
--> statement-breakpoint
ALTER TABLE "timesheet_settings" DROP COLUMN IF EXISTS "approver_source";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."timesheet_approver_source";
