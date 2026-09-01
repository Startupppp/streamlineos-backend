-- Rollback 0866: un-validate the FK constraints from migrations 0860-0865.
--
-- VALIDATE CONSTRAINT cannot be undone directly; the only way to return to the
-- NOT VALID state is to drop each constraint and re-add it NOT VALID. No column is
-- dropped and no backfilled data is lost.
--
-- Roll the code back first if services have already switched to using these columns
-- as the authoritative ownership pointer.

SET lock_timeout = '60s';

--> statement-breakpoint
ALTER TABLE "reimbursements" DROP CONSTRAINT IF EXISTS "fk_reimbursements_user_actor";

--> statement-breakpoint
ALTER TABLE "reimbursements"
  ADD CONSTRAINT "fk_reimbursements_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "salary_loans" DROP CONSTRAINT IF EXISTS "fk_salary_loans_user_actor";

--> statement-breakpoint
ALTER TABLE "salary_loans"
  ADD CONSTRAINT "fk_salary_loans_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "bonuses" DROP CONSTRAINT IF EXISTS "fk_bonuses_user_actor";

--> statement-breakpoint
ALTER TABLE "bonuses"
  ADD CONSTRAINT "fk_bonuses_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "fnf_settlements" DROP CONSTRAINT IF EXISTS "fk_fnf_settlements_user_actor";

--> statement-breakpoint
ALTER TABLE "fnf_settlements"
  ADD CONSTRAINT "fk_fnf_settlements_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "expenses" DROP CONSTRAINT IF EXISTS "fk_expenses_user_actor";

--> statement-breakpoint
ALTER TABLE "expenses"
  ADD CONSTRAINT "fk_expenses_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "payroll_run_employees" DROP CONSTRAINT IF EXISTS "fk_payroll_run_employees_user_actor";

--> statement-breakpoint
ALTER TABLE "payroll_run_employees"
  ADD CONSTRAINT "fk_payroll_run_employees_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "payroll_inputs" DROP CONSTRAINT IF EXISTS "fk_payroll_inputs_user_actor";

--> statement-breakpoint
ALTER TABLE "payroll_inputs"
  ADD CONSTRAINT "fk_payroll_inputs_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "employee_salary_profiles" DROP CONSTRAINT IF EXISTS "fk_employee_salary_profiles_user_actor";

--> statement-breakpoint
ALTER TABLE "employee_salary_profiles"
  ADD CONSTRAINT "fk_employee_salary_profiles_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "payslip_publications" DROP CONSTRAINT IF EXISTS "fk_payslip_publications_user_actor";

--> statement-breakpoint
ALTER TABLE "payslip_publications"
  ADD CONSTRAINT "fk_payslip_publications_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "hr_payroll_input_snapshots" DROP CONSTRAINT IF EXISTS "fk_hr_payroll_input_snapshots_user_actor";

--> statement-breakpoint
ALTER TABLE "hr_payroll_input_snapshots"
  ADD CONSTRAINT "fk_hr_payroll_input_snapshots_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "hr_payroll_adjustments" DROP CONSTRAINT IF EXISTS "fk_hr_payroll_adjustments_user_actor";

--> statement-breakpoint
ALTER TABLE "hr_payroll_adjustments"
  ADD CONSTRAINT "fk_hr_payroll_adjustments_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "asset_returns" DROP CONSTRAINT IF EXISTS "fk_asset_returns_user_actor";

--> statement-breakpoint
ALTER TABLE "asset_returns"
  ADD CONSTRAINT "fk_asset_returns_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "fk_support_tickets_assignee_actor";

--> statement-breakpoint
ALTER TABLE "support_tickets"
  ADD CONSTRAINT "fk_support_tickets_assignee_actor"
  FOREIGN KEY ("org_id", "assignee_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("assignee_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "fk_support_tickets_created_actor";

--> statement-breakpoint
ALTER TABLE "support_tickets"
  ADD CONSTRAINT "fk_support_tickets_created_actor"
  FOREIGN KEY ("org_id", "created_by_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("created_by_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "support_macros" DROP CONSTRAINT IF EXISTS "fk_support_macros_created_actor";

--> statement-breakpoint
ALTER TABLE "support_macros"
  ADD CONSTRAINT "fk_support_macros_created_actor"
  FOREIGN KEY ("org_id", "created_by_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("created_by_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "support_routing_rules" DROP CONSTRAINT IF EXISTS "fk_support_routing_rules_assignee_actor";

--> statement-breakpoint
ALTER TABLE "support_routing_rules"
  ADD CONSTRAINT "fk_support_routing_rules_assignee_actor"
  FOREIGN KEY ("org_id", "assignee_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("assignee_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "support_saved_views" DROP CONSTRAINT IF EXISTS "fk_support_saved_views_owner_actor";

--> statement-breakpoint
ALTER TABLE "support_saved_views"
  ADD CONSTRAINT "fk_support_saved_views_owner_actor"
  FOREIGN KEY ("org_id", "owner_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "support_ticket_watchers" DROP CONSTRAINT IF EXISTS "fk_support_ticket_watchers_user_actor";

--> statement-breakpoint
ALTER TABLE "support_ticket_watchers"
  ADD CONSTRAINT "fk_support_ticket_watchers_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "support_agent_skills" DROP CONSTRAINT IF EXISTS "fk_support_agent_skills_user_actor";

--> statement-breakpoint
ALTER TABLE "support_agent_skills"
  ADD CONSTRAINT "fk_support_agent_skills_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "support_agent_availability" DROP CONSTRAINT IF EXISTS "fk_support_agent_availability_user_actor";

--> statement-breakpoint
ALTER TABLE "support_agent_availability"
  ADD CONSTRAINT "fk_support_agent_availability_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "support_message_mentions" DROP CONSTRAINT IF EXISTS "fk_support_message_mentions_mentioned_actor";

--> statement-breakpoint
ALTER TABLE "support_message_mentions"
  ADD CONSTRAINT "fk_support_message_mentions_mentioned_actor"
  FOREIGN KEY ("org_id", "mentioned_user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "support_ticket_drafts" DROP CONSTRAINT IF EXISTS "fk_support_ticket_drafts_user_actor";

--> statement-breakpoint
ALTER TABLE "support_ticket_drafts"
  ADD CONSTRAINT "fk_support_ticket_drafts_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "kb_articles" DROP CONSTRAINT IF EXISTS "fk_kb_articles_owner_actor";

--> statement-breakpoint
ALTER TABLE "kb_articles"
  ADD CONSTRAINT "fk_kb_articles_owner_actor"
  FOREIGN KEY ("org_id", "owner_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("owner_membership_id")
  NOT VALID;
