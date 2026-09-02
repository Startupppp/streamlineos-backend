-- 1025 DOWN -- drops the six composite self/sibling foreign keys and their six supporting
-- partial indexes. Reverting leaves the six pointer columns declared but unconstrained,
-- which is the state 1025 found: a row in one organisation may again name a parent in
-- another.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS fk_support_tickets_merged_into_ticket;
--> statement-breakpoint

ALTER TABLE payroll_policies DROP CONSTRAINT IF EXISTS fk_payroll_policies_active_version;
--> statement-breakpoint

ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS fk_payroll_runs_source_run;
--> statement-breakpoint

ALTER TABLE hr_policies DROP CONSTRAINT IF EXISTS fk_hr_policies_parent_policy;
--> statement-breakpoint

ALTER TABLE hr_templates DROP CONSTRAINT IF EXISTS fk_hr_templates_parent_template;
--> statement-breakpoint

ALTER TABLE hr_automation_runs DROP CONSTRAINT IF EXISTS fk_hr_automation_runs_triggered_by_run;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_support_tickets_merged_into;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_payroll_policies_active_version;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_payroll_runs_org_source_run;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_hr_policies_parent_policy;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_hr_templates_parent_template;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_hr_automation_runs_triggered_by_run;
