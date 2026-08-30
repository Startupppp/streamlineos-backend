CREATE INDEX IF NOT EXISTS "idx_timesheets_org_user_date" ON "timesheets" ("org_id","user_id","date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timesheets_org_billing" ON "timesheets" ("org_id","is_billable","invoicing_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timesheets_timer_session" ON "timesheets" ("timer_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_timesheets_work_log" ON "timesheets" ("org_id","user_id","date") WHERE ticket_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_timesheet_budgets_active_project" ON "timesheet_budgets" ("org_id","project_id") WHERE status = 'ACTIVE';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timesheet_exports_created_by" ON "timesheet_exports" ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timesheet_periods_current_approver" ON "timesheet_periods" ("org_id","current_approver_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_timesheet_rate_cards_org_name" ON "timesheet_rate_cards" ("org_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timesheet_rates_rate_card" ON "timesheet_rates" ("rate_card_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timer_sessions_ticket" ON "timer_sessions" ("ticket_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timer_sessions_project" ON "timer_sessions" ("project_id");
