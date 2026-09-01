-- 0866: VALIDATE all NOT VALID FK constraints added by migrations 0860-0865.
--
-- NOT VALID skips the full-table scan; VALIDATE checks existing rows after the fact.
-- Running VALIDATE in a separate migration avoids the long ACCESS EXCLUSIVE lock in
-- the EXPAND migrations. Each VALIDATE acquires SHARE UPDATE EXCLUSIVE, which allows
-- concurrent reads and DML.

SET lock_timeout = '60s';

--> statement-breakpoint
ALTER TABLE "reimbursements" VALIDATE CONSTRAINT "fk_reimbursements_user_actor";

--> statement-breakpoint
ALTER TABLE "salary_loans" VALIDATE CONSTRAINT "fk_salary_loans_user_actor";

--> statement-breakpoint
ALTER TABLE "bonuses" VALIDATE CONSTRAINT "fk_bonuses_user_actor";

--> statement-breakpoint
ALTER TABLE "fnf_settlements" VALIDATE CONSTRAINT "fk_fnf_settlements_user_actor";

--> statement-breakpoint
ALTER TABLE "expenses" VALIDATE CONSTRAINT "fk_expenses_user_actor";

--> statement-breakpoint
ALTER TABLE "payroll_run_employees" VALIDATE CONSTRAINT "fk_payroll_run_employees_user_actor";

--> statement-breakpoint
ALTER TABLE "payroll_inputs" VALIDATE CONSTRAINT "fk_payroll_inputs_user_actor";

--> statement-breakpoint
ALTER TABLE "employee_salary_profiles" VALIDATE CONSTRAINT "fk_employee_salary_profiles_user_actor";

--> statement-breakpoint
ALTER TABLE "payslip_publications" VALIDATE CONSTRAINT "fk_payslip_publications_user_actor";

--> statement-breakpoint
ALTER TABLE "hr_payroll_input_snapshots" VALIDATE CONSTRAINT "fk_hr_payroll_input_snapshots_user_actor";

--> statement-breakpoint
ALTER TABLE "hr_payroll_adjustments" VALIDATE CONSTRAINT "fk_hr_payroll_adjustments_user_actor";

--> statement-breakpoint
ALTER TABLE "asset_returns" VALIDATE CONSTRAINT "fk_asset_returns_user_actor";

--> statement-breakpoint
ALTER TABLE "support_tickets" VALIDATE CONSTRAINT "fk_support_tickets_assignee_actor";

--> statement-breakpoint
ALTER TABLE "support_tickets" VALIDATE CONSTRAINT "fk_support_tickets_created_actor";

--> statement-breakpoint
ALTER TABLE "support_macros" VALIDATE CONSTRAINT "fk_support_macros_created_actor";

--> statement-breakpoint
ALTER TABLE "support_routing_rules" VALIDATE CONSTRAINT "fk_support_routing_rules_assignee_actor";

--> statement-breakpoint
ALTER TABLE "support_saved_views" VALIDATE CONSTRAINT "fk_support_saved_views_owner_actor";

--> statement-breakpoint
ALTER TABLE "support_ticket_watchers" VALIDATE CONSTRAINT "fk_support_ticket_watchers_user_actor";

--> statement-breakpoint
ALTER TABLE "support_agent_skills" VALIDATE CONSTRAINT "fk_support_agent_skills_user_actor";

--> statement-breakpoint
ALTER TABLE "support_agent_availability" VALIDATE CONSTRAINT "fk_support_agent_availability_user_actor";

--> statement-breakpoint
ALTER TABLE "support_message_mentions" VALIDATE CONSTRAINT "fk_support_message_mentions_mentioned_actor";

--> statement-breakpoint
ALTER TABLE "support_ticket_drafts" VALIDATE CONSTRAINT "fk_support_ticket_drafts_user_actor";

--> statement-breakpoint
ALTER TABLE "kb_articles" VALIDATE CONSTRAINT "fk_kb_articles_owner_actor";
