SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE timesheets VALIDATE CONSTRAINT fk_timesheets_locked_by_membership;
--> statement-breakpoint
ALTER TABLE timesheet_audit_events VALIDATE CONSTRAINT fk_timesheet_audit_actor_membership;
--> statement-breakpoint
ALTER TABLE timesheet_exports VALIDATE CONSTRAINT fk_timesheet_exports_created_by_membership;
--> statement-breakpoint
ALTER TABLE timesheet_exports VALIDATE CONSTRAINT fk_timesheet_exports_ack_by_membership;
--> statement-breakpoint
ALTER TABLE timesheet_settings_history VALIDATE CONSTRAINT fk_ts_settings_history_changed_by_membership;
--> statement-breakpoint
ALTER TABLE timesheet_exceptions VALIDATE CONSTRAINT fk_timesheet_exceptions_resolved_by_membership;
