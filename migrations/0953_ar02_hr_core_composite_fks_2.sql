-- AR-02: composite tenant FKs — HR core part 2 + leave
-- Covers: hr_legal_hold_items, hr_payroll_adjustments, hr_payroll_input_snapshots,
--         hr_policy_scopes, hr_poll_votes, hr_position_transitions, hr_positions,
--         hr_probation_reviews, hr_reporting_lines, hr_role_skill_requirements,
--         hr_succession_plans, hr_template_renders, hr_time_devices,
--         hr_webhook_deliveries, hr_work_authorizations, hr_workflow_*,
--         leave_balances, leave_policies, leave_requests

SET lock_timeout = DEFAULT;

ALTER TABLE hr_legal_hold_items
  ADD CONSTRAINT fk_hr_legal_hold_items_org_hold
  FOREIGN KEY (org_id, hold_id)
  REFERENCES hr_legal_holds (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_legal_hold_items VALIDATE CONSTRAINT fk_hr_legal_hold_items_org_hold;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_payroll_adjustments
  ADD CONSTRAINT fk_hr_payroll_adjustments_org_period
  FOREIGN KEY (org_id, period_id)
  REFERENCES hr_payroll_input_periods (org_id, id)
  ON DELETE SET NULL (period_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_payroll_adjustments VALIDATE CONSTRAINT fk_hr_payroll_adjustments_org_period;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_payroll_input_snapshots
  ADD CONSTRAINT fk_hr_payroll_input_snapshots_org_period
  FOREIGN KEY (org_id, period_id)
  REFERENCES hr_payroll_input_periods (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_payroll_input_snapshots VALIDATE CONSTRAINT fk_hr_payroll_input_snapshots_org_period;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_policy_scopes
  ADD CONSTRAINT fk_hr_policy_scopes_org_policy
  FOREIGN KEY (org_id, policy_id)
  REFERENCES hr_policies (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_policy_scopes VALIDATE CONSTRAINT fk_hr_policy_scopes_org_policy;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_poll_votes
  ADD CONSTRAINT fk_hr_poll_votes_org_poll
  FOREIGN KEY (org_id, poll_id)
  REFERENCES hr_polls (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_poll_votes VALIDATE CONSTRAINT fk_hr_poll_votes_org_poll;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_position_transitions
  ADD CONSTRAINT fk_hr_position_transitions_org_from_status
  FOREIGN KEY (org_id, from_status_id)
  REFERENCES hr_position_statuses (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_position_transitions VALIDATE CONSTRAINT fk_hr_position_transitions_org_from_status;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_position_transitions
  ADD CONSTRAINT fk_hr_position_transitions_org_to_status
  FOREIGN KEY (org_id, to_status_id)
  REFERENCES hr_position_statuses (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_position_transitions VALIDATE CONSTRAINT fk_hr_position_transitions_org_to_status;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_positions
  ADD CONSTRAINT fk_hr_positions_org_department
  FOREIGN KEY (org_id, department_id)
  REFERENCES org_units (org_id, id)
  ON DELETE SET NULL (department_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_positions VALIDATE CONSTRAINT fk_hr_positions_org_department;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_probation_reviews
  ADD CONSTRAINT fk_hr_probation_reviews_org_employment
  FOREIGN KEY (org_id, employment_id)
  REFERENCES hr_employments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_probation_reviews VALIDATE CONSTRAINT fk_hr_probation_reviews_org_employment;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_probation_reviews
  ADD CONSTRAINT fk_hr_probation_reviews_org_person
  FOREIGN KEY (org_id, person_id)
  REFERENCES hr_people (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_probation_reviews VALIDATE CONSTRAINT fk_hr_probation_reviews_org_person;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_probation_reviews
  ADD CONSTRAINT fk_hr_probation_reviews_org_review_template
  FOREIGN KEY (org_id, review_template_id)
  REFERENCES hr_templates (org_id, id)
  ON DELETE SET NULL (review_template_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_probation_reviews VALIDATE CONSTRAINT fk_hr_probation_reviews_org_review_template;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_reporting_lines
  ADD CONSTRAINT fk_hr_reporting_lines_org_employment
  FOREIGN KEY (org_id, employment_id)
  REFERENCES hr_employments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_reporting_lines VALIDATE CONSTRAINT fk_hr_reporting_lines_org_employment;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_reporting_lines
  ADD CONSTRAINT fk_hr_reporting_lines_org_manager_employment
  FOREIGN KEY (org_id, manager_employment_id)
  REFERENCES hr_employments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_reporting_lines VALIDATE CONSTRAINT fk_hr_reporting_lines_org_manager_employment;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_role_skill_requirements
  ADD CONSTRAINT fk_hr_role_skill_requirements_org_job_role
  FOREIGN KEY (org_id, job_role_id)
  REFERENCES hr_job_roles (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_role_skill_requirements VALIDATE CONSTRAINT fk_hr_role_skill_requirements_org_job_role;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_succession_plans
  ADD CONSTRAINT fk_hr_succession_plans_org_job_role
  FOREIGN KEY (org_id, job_role_id)
  REFERENCES hr_job_roles (org_id, id)
  ON DELETE SET NULL (job_role_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_succession_plans VALIDATE CONSTRAINT fk_hr_succession_plans_org_job_role;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_template_renders
  ADD CONSTRAINT fk_hr_template_renders_org_template
  FOREIGN KEY (org_id, template_id)
  REFERENCES hr_templates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_template_renders VALIDATE CONSTRAINT fk_hr_template_renders_org_template;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_time_devices
  ADD CONSTRAINT fk_hr_time_devices_org_location
  FOREIGN KEY (org_id, location_id)
  REFERENCES org_units (org_id, id)
  ON DELETE SET NULL (location_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_time_devices VALIDATE CONSTRAINT fk_hr_time_devices_org_location;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_webhook_deliveries
  ADD CONSTRAINT fk_hr_webhook_deliveries_org_subscription
  FOREIGN KEY (org_id, subscription_id)
  REFERENCES hr_webhook_subscriptions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_webhook_deliveries VALIDATE CONSTRAINT fk_hr_webhook_deliveries_org_subscription;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_work_authorizations
  ADD CONSTRAINT fk_hr_work_authorizations_org_employment
  FOREIGN KEY (org_id, employment_id)
  REFERENCES hr_employments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_work_authorizations VALIDATE CONSTRAINT fk_hr_work_authorizations_org_employment;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_workflow_instances
  ADD CONSTRAINT fk_hr_workflow_instances_org_definition
  FOREIGN KEY (org_id, definition_id)
  REFERENCES hr_workflow_definitions (org_id, id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_workflow_instances VALIDATE CONSTRAINT fk_hr_workflow_instances_org_definition;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_workflow_step_actions
  ADD CONSTRAINT fk_hr_workflow_step_actions_org_instance
  FOREIGN KEY (org_id, instance_id)
  REFERENCES hr_workflow_instances (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_workflow_step_actions VALIDATE CONSTRAINT fk_hr_workflow_step_actions_org_instance;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_workflow_steps
  ADD CONSTRAINT fk_hr_workflow_steps_org_definition
  FOREIGN KEY (org_id, definition_id)
  REFERENCES hr_workflow_definitions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_workflow_steps VALIDATE CONSTRAINT fk_hr_workflow_steps_org_definition;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE leave_balances
  ADD CONSTRAINT fk_leave_balances_org_leave_type
  FOREIGN KEY (org_id, leave_type_id)
  REFERENCES leave_types (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE leave_balances VALIDATE CONSTRAINT fk_leave_balances_org_leave_type;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE leave_policies
  ADD CONSTRAINT fk_leave_policies_org_leave_type
  FOREIGN KEY (org_id, leave_type_id)
  REFERENCES leave_types (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE leave_policies VALIDATE CONSTRAINT fk_leave_policies_org_leave_type;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE leave_requests
  ADD CONSTRAINT fk_leave_requests_org_leave_type
  FOREIGN KEY (org_id, leave_type_id)
  REFERENCES leave_types (org_id, id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE leave_requests VALIDATE CONSTRAINT fk_leave_requests_org_leave_type;
SET lock_timeout = DEFAULT;
