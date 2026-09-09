-- =============================================================================
-- 0659 — Composite tenant foreign keys: HR
-- =============================================================================
-- HR — people, employment, leave, documents, assets.
--
-- 68 composite tenant foreign keys.
-- Requires 0656, which authors the unique keys these reference.
--
-- Series 0656-0664. Part of one change: 458 composite tenant foreign keys and
-- the 165 unique keys they reference existed only on the shared Neon branch,
-- created by hand and authored by no migration. backend/CLAUDE.md §3 requires
-- them and says application predicates and RLS do not replace them, so on a
-- database rebuilt from migrations/ nothing stopped a child row referencing a
-- parent in another organisation.
--
-- Shape rules, all of them load-bearing:
--
--   * Every definition is taken verbatim from pg_get_constraintdef, so the
--     ON DELETE clauses that nine of them carry survive. The only edits are
--     mechanical: a trailing " NOT VALID" is stripped from the four that are
--     live-but-unvalidated (we append our own), and the REFERENCES target is
--     schema-qualified — see the next point.
--
--   * Every table name is schema-qualified in all three positions: the
--     to_regclass probe, the ALTER TABLE, and the REFERENCES target. 123 of
--     these constraints are outside public (120 build, 3 build_events), and
--     to_regclass('public.x') on a build table returns NULL — the guard would
--     conclude the table does not exist, skip, and never create the constraint
--     on a fresh build. That is the guard's protection inverted, producing
--     exactly the defect this series exists to fix. The same trap bites the
--     REFERENCES clause from the other side: this database's search_path is
--     '"$user", public, build_events, app', so pg_get_constraintdef renders
--     build_events.ticket_comments as a bare "ticket_comments", which resolves
--     to the wrong table (or to nothing) under any other search_path.
--
--   * ADD CONSTRAINT ... NOT VALID first, VALIDATE CONSTRAINT as a separate
--     statement. A one-step ADD takes ACCESS EXCLUSIVE on BOTH tables while it
--     installs the triggers, so it stalls every write to both behind any long
--     read.
--
--   * Both halves are guarded on pg_constraint via to_regclass — never
--     ::regclass, which throws on a missing table. All of these already exist
--     on the database this was written against, so each file must be a no-op
--     there and the creating statement anywhere else.
--
--   * lock_timeout so a blocked ALTER fails fast instead of queueing and
--     blocking the table behind it.
-- =============================================================================

SET lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.asset_returns') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_asset_returns_asset_id_org'
                     AND conrelid = to_regclass('public.asset_returns')) THEN
    ALTER TABLE "public"."asset_returns" ADD CONSTRAINT "fk_asset_returns_asset_id_org" FOREIGN KEY (org_id, asset_id) REFERENCES "public"."assets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_asset_returns_asset_id_org'
             AND conrelid = to_regclass('public.asset_returns') AND NOT convalidated) THEN
    ALTER TABLE "public"."asset_returns" VALIDATE CONSTRAINT "fk_asset_returns_asset_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.biometric_logs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_biometric_logs_device_id_org'
                     AND conrelid = to_regclass('public.biometric_logs')) THEN
    ALTER TABLE "public"."biometric_logs" ADD CONSTRAINT "fk_biometric_logs_device_id_org" FOREIGN KEY (org_id, device_id) REFERENCES "public"."biometric_devices"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_biometric_logs_device_id_org'
             AND conrelid = to_regclass('public.biometric_logs') AND NOT convalidated) THEN
    ALTER TABLE "public"."biometric_logs" VALIDATE CONSTRAINT "fk_biometric_logs_device_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.document_audit_logs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_document_audit_logs_onboarding_document_id_org'
                     AND conrelid = to_regclass('public.document_audit_logs')) THEN
    ALTER TABLE "public"."document_audit_logs" ADD CONSTRAINT "fk_document_audit_logs_onboarding_document_id_org" FOREIGN KEY (org_id, onboarding_document_id) REFERENCES "public"."onboarding_documents"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_document_audit_logs_onboarding_document_id_org'
             AND conrelid = to_regclass('public.document_audit_logs') AND NOT convalidated) THEN
    ALTER TABLE "public"."document_audit_logs" VALIDATE CONSTRAINT "fk_document_audit_logs_onboarding_document_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.document_template_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_document_template_versions_template_id_org'
                     AND conrelid = to_regclass('public.document_template_versions')) THEN
    ALTER TABLE "public"."document_template_versions" ADD CONSTRAINT "fk_document_template_versions_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES "public"."document_templates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_document_template_versions_template_id_org'
             AND conrelid = to_regclass('public.document_template_versions') AND NOT convalidated) THEN
    ALTER TABLE "public"."document_template_versions" VALIDATE CONSTRAINT "fk_document_template_versions_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.documents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_documents_parent_document_id_org'
                     AND conrelid = to_regclass('public.documents')) THEN
    ALTER TABLE "public"."documents" ADD CONSTRAINT "fk_documents_parent_document_id_org" FOREIGN KEY (org_id, parent_document_id) REFERENCES "public"."documents"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_documents_parent_document_id_org'
             AND conrelid = to_regclass('public.documents') AND NOT convalidated) THEN
    ALTER TABLE "public"."documents" VALIDATE CONSTRAINT "fk_documents_parent_document_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.employee_career_plans') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_career_plans_path_id_org'
                     AND conrelid = to_regclass('public.employee_career_plans')) THEN
    ALTER TABLE "public"."employee_career_plans" ADD CONSTRAINT "fk_employee_career_plans_path_id_org" FOREIGN KEY (org_id, path_id) REFERENCES "public"."career_paths"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_career_plans_path_id_org'
             AND conrelid = to_regclass('public.employee_career_plans') AND NOT convalidated) THEN
    ALTER TABLE "public"."employee_career_plans" VALIDATE CONSTRAINT "fk_employee_career_plans_path_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.employee_salary_profile_components') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_salary_profile_components_component_id_org'
                     AND conrelid = to_regclass('public.employee_salary_profile_components')) THEN
    ALTER TABLE "public"."employee_salary_profile_components" ADD CONSTRAINT "fk_employee_salary_profile_components_component_id_org" FOREIGN KEY (org_id, component_id) REFERENCES "public"."salary_components"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_salary_profile_components_component_id_org'
             AND conrelid = to_regclass('public.employee_salary_profile_components') AND NOT convalidated) THEN
    ALTER TABLE "public"."employee_salary_profile_components" VALIDATE CONSTRAINT "fk_employee_salary_profile_components_component_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.employee_salary_profile_components') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_salary_profile_components_profile_id_org'
                     AND conrelid = to_regclass('public.employee_salary_profile_components')) THEN
    ALTER TABLE "public"."employee_salary_profile_components" ADD CONSTRAINT "fk_employee_salary_profile_components_profile_id_org" FOREIGN KEY (org_id, profile_id) REFERENCES "public"."employee_salary_profiles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_salary_profile_components_profile_id_org'
             AND conrelid = to_regclass('public.employee_salary_profile_components') AND NOT convalidated) THEN
    ALTER TABLE "public"."employee_salary_profile_components" VALIDATE CONSTRAINT "fk_employee_salary_profile_components_profile_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.employee_shift_assignments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_shift_assignments_shift_id_org'
                     AND conrelid = to_regclass('public.employee_shift_assignments')) THEN
    ALTER TABLE "public"."employee_shift_assignments" ADD CONSTRAINT "fk_employee_shift_assignments_shift_id_org" FOREIGN KEY (org_id, shift_id) REFERENCES "public"."shift_templates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_employee_shift_assignments_shift_id_org'
             AND conrelid = to_regclass('public.employee_shift_assignments') AND NOT convalidated) THEN
    ALTER TABLE "public"."employee_shift_assignments" VALIDATE CONSTRAINT "fk_employee_shift_assignments_shift_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.exit_checklists') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_exit_checklists_resignation_id_org'
                     AND conrelid = to_regclass('public.exit_checklists')) THEN
    ALTER TABLE "public"."exit_checklists" ADD CONSTRAINT "fk_exit_checklists_resignation_id_org" FOREIGN KEY (org_id, resignation_id) REFERENCES "public"."resignations"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_exit_checklists_resignation_id_org'
             AND conrelid = to_regclass('public.exit_checklists') AND NOT convalidated) THEN
    ALTER TABLE "public"."exit_checklists" VALIDATE CONSTRAINT "fk_exit_checklists_resignation_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fnf_settlements') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fnf_settlements_resignation_id_org'
                     AND conrelid = to_regclass('public.fnf_settlements')) THEN
    ALTER TABLE "public"."fnf_settlements" ADD CONSTRAINT "fk_fnf_settlements_resignation_id_org" FOREIGN KEY (org_id, resignation_id) REFERENCES "public"."resignations"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fnf_settlements_resignation_id_org'
             AND conrelid = to_regclass('public.fnf_settlements') AND NOT convalidated) THEN
    ALTER TABLE "public"."fnf_settlements" VALIDATE CONSTRAINT "fk_fnf_settlements_resignation_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.handbook_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_handbook_versions_document_id_org'
                     AND conrelid = to_regclass('public.handbook_versions')) THEN
    ALTER TABLE "public"."handbook_versions" ADD CONSTRAINT "fk_handbook_versions_document_id_org" FOREIGN KEY (org_id, document_id) REFERENCES "public"."rich_documents"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_handbook_versions_document_id_org'
             AND conrelid = to_regclass('public.handbook_versions') AND NOT convalidated) THEN
    ALTER TABLE "public"."handbook_versions" VALIDATE CONSTRAINT "fk_handbook_versions_document_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.headcount_requests') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_headcount_requests_linked_job_posting_id_org'
                     AND conrelid = to_regclass('public.headcount_requests')) THEN
    ALTER TABLE "public"."headcount_requests" ADD CONSTRAINT "fk_headcount_requests_linked_job_posting_id_org" FOREIGN KEY (org_id, linked_job_posting_id) REFERENCES "public"."job_postings"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_headcount_requests_linked_job_posting_id_org'
             AND conrelid = to_regclass('public.headcount_requests') AND NOT convalidated) THEN
    ALTER TABLE "public"."headcount_requests" VALIDATE CONSTRAINT "fk_headcount_requests_linked_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_accommodation_tasks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_accommodation_tasks_request_id_org'
                     AND conrelid = to_regclass('public.hr_accommodation_tasks')) THEN
    ALTER TABLE "public"."hr_accommodation_tasks" ADD CONSTRAINT "fk_hr_accommodation_tasks_request_id_org" FOREIGN KEY (org_id, request_id) REFERENCES "public"."hr_accommodation_requests"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_accommodation_tasks_request_id_org'
             AND conrelid = to_regclass('public.hr_accommodation_tasks') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_accommodation_tasks" VALIDATE CONSTRAINT "fk_hr_accommodation_tasks_request_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_automation_runs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_automation_runs_rule_id_org'
                     AND conrelid = to_regclass('public.hr_automation_runs')) THEN
    ALTER TABLE "public"."hr_automation_runs" ADD CONSTRAINT "fk_hr_automation_runs_rule_id_org" FOREIGN KEY (org_id, rule_id) REFERENCES "public"."hr_automation_rules"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_automation_runs_rule_id_org'
             AND conrelid = to_regclass('public.hr_automation_runs') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_automation_runs" VALIDATE CONSTRAINT "fk_hr_automation_runs_rule_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_badge_awards') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_badge_awards_badge_id_org'
                     AND conrelid = to_regclass('public.hr_badge_awards')) THEN
    ALTER TABLE "public"."hr_badge_awards" ADD CONSTRAINT "fk_hr_badge_awards_badge_id_org" FOREIGN KEY (org_id, badge_id) REFERENCES "public"."hr_badges"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_badge_awards_badge_id_org'
             AND conrelid = to_regclass('public.hr_badge_awards') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_badge_awards" VALIDATE CONSTRAINT "fk_hr_badge_awards_badge_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_benefit_enrollment_windows') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_benefit_enrollment_windows_plan_id_org'
                     AND conrelid = to_regclass('public.hr_benefit_enrollment_windows')) THEN
    ALTER TABLE "public"."hr_benefit_enrollment_windows" ADD CONSTRAINT "fk_hr_benefit_enrollment_windows_plan_id_org" FOREIGN KEY (org_id, plan_id) REFERENCES "public"."hr_benefit_plans"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_benefit_enrollment_windows_plan_id_org'
             AND conrelid = to_regclass('public.hr_benefit_enrollment_windows') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_benefit_enrollment_windows" VALIDATE CONSTRAINT "fk_hr_benefit_enrollment_windows_plan_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_benefit_enrollments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_benefit_enrollments_plan_id_org'
                     AND conrelid = to_regclass('public.hr_benefit_enrollments')) THEN
    ALTER TABLE "public"."hr_benefit_enrollments" ADD CONSTRAINT "fk_hr_benefit_enrollments_plan_id_org" FOREIGN KEY (org_id, plan_id) REFERENCES "public"."hr_benefit_plans"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_benefit_enrollments_plan_id_org'
             AND conrelid = to_regclass('public.hr_benefit_enrollments') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_benefit_enrollments" VALIDATE CONSTRAINT "fk_hr_benefit_enrollments_plan_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_calibration_entries') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_calibration_entries_cycle_id_org'
                     AND conrelid = to_regclass('public.hr_calibration_entries')) THEN
    ALTER TABLE "public"."hr_calibration_entries" ADD CONSTRAINT "fk_hr_calibration_entries_cycle_id_org" FOREIGN KEY (org_id, cycle_id) REFERENCES "public"."review_cycles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_calibration_entries_cycle_id_org'
             AND conrelid = to_regclass('public.hr_calibration_entries') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_calibration_entries" VALIDATE CONSTRAINT "fk_hr_calibration_entries_cycle_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_case_documents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_case_documents_case_id_org'
                     AND conrelid = to_regclass('public.hr_case_documents')) THEN
    ALTER TABLE "public"."hr_case_documents" ADD CONSTRAINT "fk_hr_case_documents_case_id_org" FOREIGN KEY (org_id, case_id) REFERENCES "public"."hr_cases"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_case_documents_case_id_org'
             AND conrelid = to_regclass('public.hr_case_documents') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_case_documents" VALIDATE CONSTRAINT "fk_hr_case_documents_case_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_case_notes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_case_notes_case_id_org'
                     AND conrelid = to_regclass('public.hr_case_notes')) THEN
    ALTER TABLE "public"."hr_case_notes" ADD CONSTRAINT "fk_hr_case_notes_case_id_org" FOREIGN KEY (org_id, case_id) REFERENCES "public"."hr_cases"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_case_notes_case_id_org'
             AND conrelid = to_regclass('public.hr_case_notes') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_case_notes" VALIDATE CONSTRAINT "fk_hr_case_notes_case_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_community_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_community_members_community_id_org'
                     AND conrelid = to_regclass('public.hr_community_members')) THEN
    ALTER TABLE "public"."hr_community_members" ADD CONSTRAINT "fk_hr_community_members_community_id_org" FOREIGN KEY (org_id, community_id) REFERENCES "public"."hr_communities"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_community_members_community_id_org'
             AND conrelid = to_regclass('public.hr_community_members') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_community_members" VALIDATE CONSTRAINT "fk_hr_community_members_community_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_comp_budget_pools') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_comp_budget_pools_cycle_id_org'
                     AND conrelid = to_regclass('public.hr_comp_budget_pools')) THEN
    ALTER TABLE "public"."hr_comp_budget_pools" ADD CONSTRAINT "fk_hr_comp_budget_pools_cycle_id_org" FOREIGN KEY (org_id, cycle_id) REFERENCES "public"."hr_comp_cycles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_comp_budget_pools_cycle_id_org'
             AND conrelid = to_regclass('public.hr_comp_budget_pools') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_comp_budget_pools" VALIDATE CONSTRAINT "fk_hr_comp_budget_pools_cycle_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_comp_recommendations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_comp_recommendations_cycle_id_org'
                     AND conrelid = to_regclass('public.hr_comp_recommendations')) THEN
    ALTER TABLE "public"."hr_comp_recommendations" ADD CONSTRAINT "fk_hr_comp_recommendations_cycle_id_org" FOREIGN KEY (org_id, cycle_id) REFERENCES "public"."hr_comp_cycles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_comp_recommendations_cycle_id_org'
             AND conrelid = to_regclass('public.hr_comp_recommendations') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_comp_recommendations" VALIDATE CONSTRAINT "fk_hr_comp_recommendations_cycle_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_compliance_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_compliance_events_requirement_id_org'
                     AND conrelid = to_regclass('public.hr_compliance_events')) THEN
    ALTER TABLE "public"."hr_compliance_events" ADD CONSTRAINT "fk_hr_compliance_events_requirement_id_org" FOREIGN KEY (org_id, requirement_id) REFERENCES "public"."hr_compliance_requirements"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_compliance_events_requirement_id_org'
             AND conrelid = to_regclass('public.hr_compliance_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_compliance_events" VALIDATE CONSTRAINT "fk_hr_compliance_events_requirement_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_contracts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_contracts_employment_id_org'
                     AND conrelid = to_regclass('public.hr_contracts')) THEN
    ALTER TABLE "public"."hr_contracts" ADD CONSTRAINT "fk_hr_contracts_employment_id_org" FOREIGN KEY (org_id, employment_id) REFERENCES "public"."hr_employments"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_contracts_employment_id_org'
             AND conrelid = to_regclass('public.hr_contracts') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_contracts" VALIDATE CONSTRAINT "fk_hr_contracts_employment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_device_employee_mappings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_device_employee_mappings_device_id_org'
                     AND conrelid = to_regclass('public.hr_device_employee_mappings')) THEN
    ALTER TABLE "public"."hr_device_employee_mappings" ADD CONSTRAINT "fk_hr_device_employee_mappings_device_id_org" FOREIGN KEY (org_id, device_id) REFERENCES "public"."hr_time_devices"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_device_employee_mappings_device_id_org'
             AND conrelid = to_regclass('public.hr_device_employee_mappings') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_device_employee_mappings" VALIDATE CONSTRAINT "fk_hr_device_employee_mappings_device_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_device_sync_logs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_device_sync_logs_device_id_org'
                     AND conrelid = to_regclass('public.hr_device_sync_logs')) THEN
    ALTER TABLE "public"."hr_device_sync_logs" ADD CONSTRAINT "fk_hr_device_sync_logs_device_id_org" FOREIGN KEY (org_id, device_id) REFERENCES "public"."hr_time_devices"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_device_sync_logs_device_id_org'
             AND conrelid = to_regclass('public.hr_device_sync_logs') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_device_sync_logs" VALIDATE CONSTRAINT "fk_hr_device_sync_logs_device_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_disciplinary_actions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_disciplinary_actions_case_id_org'
                     AND conrelid = to_regclass('public.hr_disciplinary_actions')) THEN
    ALTER TABLE "public"."hr_disciplinary_actions" ADD CONSTRAINT "fk_hr_disciplinary_actions_case_id_org" FOREIGN KEY (org_id, case_id) REFERENCES "public"."hr_cases"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_disciplinary_actions_case_id_org'
             AND conrelid = to_regclass('public.hr_disciplinary_actions') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_disciplinary_actions" VALIDATE CONSTRAINT "fk_hr_disciplinary_actions_case_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_effective_dated_changes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_effective_dated_changes_employment_id_org'
                     AND conrelid = to_regclass('public.hr_effective_dated_changes')) THEN
    ALTER TABLE "public"."hr_effective_dated_changes" ADD CONSTRAINT "fk_hr_effective_dated_changes_employment_id_org" FOREIGN KEY (org_id, employment_id) REFERENCES "public"."hr_employments"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_effective_dated_changes_employment_id_org'
             AND conrelid = to_regclass('public.hr_effective_dated_changes') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_effective_dated_changes" VALIDATE CONSTRAINT "fk_hr_effective_dated_changes_employment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_emergency_responses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_emergency_responses_event_id_org'
                     AND conrelid = to_regclass('public.hr_emergency_responses')) THEN
    ALTER TABLE "public"."hr_emergency_responses" ADD CONSTRAINT "fk_hr_emergency_responses_event_id_org" FOREIGN KEY (org_id, event_id) REFERENCES "public"."hr_emergency_events"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_emergency_responses_event_id_org'
             AND conrelid = to_regclass('public.hr_emergency_responses') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_emergency_responses" VALIDATE CONSTRAINT "fk_hr_emergency_responses_event_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_employee_sensitive_fields') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_employee_sensitive_fields_employment_id_org'
                     AND conrelid = to_regclass('public.hr_employee_sensitive_fields')) THEN
    ALTER TABLE "public"."hr_employee_sensitive_fields" ADD CONSTRAINT "fk_hr_employee_sensitive_fields_employment_id_org" FOREIGN KEY (org_id, employment_id) REFERENCES "public"."hr_employments"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_employee_sensitive_fields_employment_id_org'
             AND conrelid = to_regclass('public.hr_employee_sensitive_fields') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_employee_sensitive_fields" VALIDATE CONSTRAINT "fk_hr_employee_sensitive_fields_employment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_employment_history') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_employment_history_employment_id_org'
                     AND conrelid = to_regclass('public.hr_employment_history')) THEN
    ALTER TABLE "public"."hr_employment_history" ADD CONSTRAINT "fk_hr_employment_history_employment_id_org" FOREIGN KEY (org_id, employment_id) REFERENCES "public"."hr_employments"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_employment_history_employment_id_org'
             AND conrelid = to_regclass('public.hr_employment_history') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_employment_history" VALIDATE CONSTRAINT "fk_hr_employment_history_employment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_employments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_employments_person_id_org'
                     AND conrelid = to_regclass('public.hr_employments')) THEN
    ALTER TABLE "public"."hr_employments" ADD CONSTRAINT "fk_hr_employments_person_id_org" FOREIGN KEY (org_id, person_id) REFERENCES "public"."hr_people"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_employments_person_id_org'
             AND conrelid = to_regclass('public.hr_employments') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_employments" VALIDATE CONSTRAINT "fk_hr_employments_person_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_equity_exercises') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_equity_exercises_grant_id_org'
                     AND conrelid = to_regclass('public.hr_equity_exercises')) THEN
    ALTER TABLE "public"."hr_equity_exercises" ADD CONSTRAINT "fk_hr_equity_exercises_grant_id_org" FOREIGN KEY (org_id, grant_id) REFERENCES "public"."hr_equity_grants"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_equity_exercises_grant_id_org'
             AND conrelid = to_regclass('public.hr_equity_exercises') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_equity_exercises" VALIDATE CONSTRAINT "fk_hr_equity_exercises_grant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_equity_vesting_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_equity_vesting_events_grant_id_org'
                     AND conrelid = to_regclass('public.hr_equity_vesting_events')) THEN
    ALTER TABLE "public"."hr_equity_vesting_events" ADD CONSTRAINT "fk_hr_equity_vesting_events_grant_id_org" FOREIGN KEY (org_id, grant_id) REFERENCES "public"."hr_equity_grants"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_equity_vesting_events_grant_id_org'
             AND conrelid = to_regclass('public.hr_equity_vesting_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_equity_vesting_events" VALIDATE CONSTRAINT "fk_hr_equity_vesting_events_grant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_form_submissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_form_submissions_form_id_org'
                     AND conrelid = to_regclass('public.hr_form_submissions')) THEN
    ALTER TABLE "public"."hr_form_submissions" ADD CONSTRAINT "fk_hr_form_submissions_form_id_org" FOREIGN KEY (org_id, form_id) REFERENCES "public"."hr_forms"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_form_submissions_form_id_org'
             AND conrelid = to_regclass('public.hr_form_submissions') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_form_submissions" VALIDATE CONSTRAINT "fk_hr_form_submissions_form_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_helpdesk_comments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_helpdesk_comments_ticket_id_org'
                     AND conrelid = to_regclass('public.hr_helpdesk_comments')) THEN
    ALTER TABLE "public"."hr_helpdesk_comments" ADD CONSTRAINT "fk_hr_helpdesk_comments_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "public"."helpdesk_tickets"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_helpdesk_comments_ticket_id_org'
             AND conrelid = to_regclass('public.hr_helpdesk_comments') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_helpdesk_comments" VALIDATE CONSTRAINT "fk_hr_helpdesk_comments_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_import_rows') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_import_rows_job_id_org'
                     AND conrelid = to_regclass('public.hr_import_rows')) THEN
    ALTER TABLE "public"."hr_import_rows" ADD CONSTRAINT "fk_hr_import_rows_job_id_org" FOREIGN KEY (org_id, job_id) REFERENCES "public"."hr_import_jobs"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_import_rows_job_id_org'
             AND conrelid = to_regclass('public.hr_import_rows') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_import_rows" VALIDATE CONSTRAINT "fk_hr_import_rows_job_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_insurance_claims') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_insurance_claims_plan_id_org'
                     AND conrelid = to_regclass('public.hr_insurance_claims')) THEN
    ALTER TABLE "public"."hr_insurance_claims" ADD CONSTRAINT "fk_hr_insurance_claims_plan_id_org" FOREIGN KEY (org_id, plan_id) REFERENCES "public"."hr_benefit_plans"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_insurance_claims_plan_id_org'
             AND conrelid = to_regclass('public.hr_insurance_claims') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_insurance_claims" VALIDATE CONSTRAINT "fk_hr_insurance_claims_plan_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_leave_ledger') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_leave_ledger_leave_type_id_org'
                     AND conrelid = to_regclass('public.hr_leave_ledger')) THEN
    ALTER TABLE "public"."hr_leave_ledger" ADD CONSTRAINT "fk_hr_leave_ledger_leave_type_id_org" FOREIGN KEY (org_id, leave_type_id) REFERENCES "public"."leave_types"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_leave_ledger_leave_type_id_org'
             AND conrelid = to_regclass('public.hr_leave_ledger') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_leave_ledger" VALIDATE CONSTRAINT "fk_hr_leave_ledger_leave_type_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_legal_hold_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_legal_hold_items_hold_id_org'
                     AND conrelid = to_regclass('public.hr_legal_hold_items')) THEN
    ALTER TABLE "public"."hr_legal_hold_items" ADD CONSTRAINT "fk_hr_legal_hold_items_hold_id_org" FOREIGN KEY (org_id, hold_id) REFERENCES "public"."hr_legal_holds"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_legal_hold_items_hold_id_org'
             AND conrelid = to_regclass('public.hr_legal_hold_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_legal_hold_items" VALIDATE CONSTRAINT "fk_hr_legal_hold_items_hold_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_payroll_adjustments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_payroll_adjustments_period_id_org'
                     AND conrelid = to_regclass('public.hr_payroll_adjustments')) THEN
    ALTER TABLE "public"."hr_payroll_adjustments" ADD CONSTRAINT "fk_hr_payroll_adjustments_period_id_org" FOREIGN KEY (org_id, period_id) REFERENCES "public"."hr_payroll_input_periods"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_payroll_adjustments_period_id_org'
             AND conrelid = to_regclass('public.hr_payroll_adjustments') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_payroll_adjustments" VALIDATE CONSTRAINT "fk_hr_payroll_adjustments_period_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_payroll_input_snapshots') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_payroll_input_snapshots_period_id_org'
                     AND conrelid = to_regclass('public.hr_payroll_input_snapshots')) THEN
    ALTER TABLE "public"."hr_payroll_input_snapshots" ADD CONSTRAINT "fk_hr_payroll_input_snapshots_period_id_org" FOREIGN KEY (org_id, period_id) REFERENCES "public"."hr_payroll_input_periods"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_payroll_input_snapshots_period_id_org'
             AND conrelid = to_regclass('public.hr_payroll_input_snapshots') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_payroll_input_snapshots" VALIDATE CONSTRAINT "fk_hr_payroll_input_snapshots_period_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_policy_scopes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_policy_scopes_policy_id_org'
                     AND conrelid = to_regclass('public.hr_policy_scopes')) THEN
    ALTER TABLE "public"."hr_policy_scopes" ADD CONSTRAINT "fk_hr_policy_scopes_policy_id_org" FOREIGN KEY (org_id, policy_id) REFERENCES "public"."hr_policies"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_policy_scopes_policy_id_org'
             AND conrelid = to_regclass('public.hr_policy_scopes') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_policy_scopes" VALIDATE CONSTRAINT "fk_hr_policy_scopes_policy_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_poll_votes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_poll_votes_poll_id_org'
                     AND conrelid = to_regclass('public.hr_poll_votes')) THEN
    ALTER TABLE "public"."hr_poll_votes" ADD CONSTRAINT "fk_hr_poll_votes_poll_id_org" FOREIGN KEY (org_id, poll_id) REFERENCES "public"."hr_polls"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_poll_votes_poll_id_org'
             AND conrelid = to_regclass('public.hr_poll_votes') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_poll_votes" VALIDATE CONSTRAINT "fk_hr_poll_votes_poll_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_probation_reviews') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_probation_reviews_employment_id_org'
                     AND conrelid = to_regclass('public.hr_probation_reviews')) THEN
    ALTER TABLE "public"."hr_probation_reviews" ADD CONSTRAINT "fk_hr_probation_reviews_employment_id_org" FOREIGN KEY (org_id, employment_id) REFERENCES "public"."hr_employments"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_probation_reviews_employment_id_org'
             AND conrelid = to_regclass('public.hr_probation_reviews') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_probation_reviews" VALIDATE CONSTRAINT "fk_hr_probation_reviews_employment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_probation_reviews') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_probation_reviews_person_id_org'
                     AND conrelid = to_regclass('public.hr_probation_reviews')) THEN
    ALTER TABLE "public"."hr_probation_reviews" ADD CONSTRAINT "fk_hr_probation_reviews_person_id_org" FOREIGN KEY (org_id, person_id) REFERENCES "public"."hr_people"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_probation_reviews_person_id_org'
             AND conrelid = to_regclass('public.hr_probation_reviews') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_probation_reviews" VALIDATE CONSTRAINT "fk_hr_probation_reviews_person_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_probation_reviews') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_probation_reviews_review_template_id_org'
                     AND conrelid = to_regclass('public.hr_probation_reviews')) THEN
    ALTER TABLE "public"."hr_probation_reviews" ADD CONSTRAINT "fk_hr_probation_reviews_review_template_id_org" FOREIGN KEY (org_id, review_template_id) REFERENCES "public"."hr_templates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_probation_reviews_review_template_id_org'
             AND conrelid = to_regclass('public.hr_probation_reviews') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_probation_reviews" VALIDATE CONSTRAINT "fk_hr_probation_reviews_review_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_reporting_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_reporting_lines_employment_id_org'
                     AND conrelid = to_regclass('public.hr_reporting_lines')) THEN
    ALTER TABLE "public"."hr_reporting_lines" ADD CONSTRAINT "fk_hr_reporting_lines_employment_id_org" FOREIGN KEY (org_id, employment_id) REFERENCES "public"."hr_employments"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_reporting_lines_employment_id_org'
             AND conrelid = to_regclass('public.hr_reporting_lines') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_reporting_lines" VALIDATE CONSTRAINT "fk_hr_reporting_lines_employment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_role_skill_requirements') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_role_skill_requirements_job_role_id_org'
                     AND conrelid = to_regclass('public.hr_role_skill_requirements')) THEN
    ALTER TABLE "public"."hr_role_skill_requirements" ADD CONSTRAINT "fk_hr_role_skill_requirements_job_role_id_org" FOREIGN KEY (org_id, job_role_id) REFERENCES "public"."hr_job_roles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_role_skill_requirements_job_role_id_org'
             AND conrelid = to_regclass('public.hr_role_skill_requirements') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_role_skill_requirements" VALIDATE CONSTRAINT "fk_hr_role_skill_requirements_job_role_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_succession_plans') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_succession_plans_job_role_id_org'
                     AND conrelid = to_regclass('public.hr_succession_plans')) THEN
    ALTER TABLE "public"."hr_succession_plans" ADD CONSTRAINT "fk_hr_succession_plans_job_role_id_org" FOREIGN KEY (org_id, job_role_id) REFERENCES "public"."hr_job_roles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_succession_plans_job_role_id_org'
             AND conrelid = to_regclass('public.hr_succession_plans') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_succession_plans" VALIDATE CONSTRAINT "fk_hr_succession_plans_job_role_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_template_renders') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_template_renders_template_id_org'
                     AND conrelid = to_regclass('public.hr_template_renders')) THEN
    ALTER TABLE "public"."hr_template_renders" ADD CONSTRAINT "fk_hr_template_renders_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES "public"."hr_templates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_template_renders_template_id_org'
             AND conrelid = to_regclass('public.hr_template_renders') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_template_renders" VALIDATE CONSTRAINT "fk_hr_template_renders_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_webhook_deliveries') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_webhook_deliveries_subscription_id_org'
                     AND conrelid = to_regclass('public.hr_webhook_deliveries')) THEN
    ALTER TABLE "public"."hr_webhook_deliveries" ADD CONSTRAINT "fk_hr_webhook_deliveries_subscription_id_org" FOREIGN KEY (org_id, subscription_id) REFERENCES "public"."hr_webhook_subscriptions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_webhook_deliveries_subscription_id_org'
             AND conrelid = to_regclass('public.hr_webhook_deliveries') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_webhook_deliveries" VALIDATE CONSTRAINT "fk_hr_webhook_deliveries_subscription_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_work_authorizations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_work_authorizations_employment_id_org'
                     AND conrelid = to_regclass('public.hr_work_authorizations')) THEN
    ALTER TABLE "public"."hr_work_authorizations" ADD CONSTRAINT "fk_hr_work_authorizations_employment_id_org" FOREIGN KEY (org_id, employment_id) REFERENCES "public"."hr_employments"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_work_authorizations_employment_id_org'
             AND conrelid = to_regclass('public.hr_work_authorizations') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_work_authorizations" VALIDATE CONSTRAINT "fk_hr_work_authorizations_employment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_workflow_instances') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_workflow_instances_definition_id_org'
                     AND conrelid = to_regclass('public.hr_workflow_instances')) THEN
    ALTER TABLE "public"."hr_workflow_instances" ADD CONSTRAINT "fk_hr_workflow_instances_definition_id_org" FOREIGN KEY (org_id, definition_id) REFERENCES "public"."hr_workflow_definitions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_workflow_instances_definition_id_org'
             AND conrelid = to_regclass('public.hr_workflow_instances') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_workflow_instances" VALIDATE CONSTRAINT "fk_hr_workflow_instances_definition_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_workflow_step_actions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_workflow_step_actions_instance_id_org'
                     AND conrelid = to_regclass('public.hr_workflow_step_actions')) THEN
    ALTER TABLE "public"."hr_workflow_step_actions" ADD CONSTRAINT "fk_hr_workflow_step_actions_instance_id_org" FOREIGN KEY (org_id, instance_id) REFERENCES "public"."hr_workflow_instances"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_workflow_step_actions_instance_id_org'
             AND conrelid = to_regclass('public.hr_workflow_step_actions') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_workflow_step_actions" VALIDATE CONSTRAINT "fk_hr_workflow_step_actions_instance_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_workflow_steps') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_workflow_steps_definition_id_org'
                     AND conrelid = to_regclass('public.hr_workflow_steps')) THEN
    ALTER TABLE "public"."hr_workflow_steps" ADD CONSTRAINT "fk_hr_workflow_steps_definition_id_org" FOREIGN KEY (org_id, definition_id) REFERENCES "public"."hr_workflow_definitions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_workflow_steps_definition_id_org'
             AND conrelid = to_regclass('public.hr_workflow_steps') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_workflow_steps" VALIDATE CONSTRAINT "fk_hr_workflow_steps_definition_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.leave_balances') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leave_balances_leave_type_id_org'
                     AND conrelid = to_regclass('public.leave_balances')) THEN
    ALTER TABLE "public"."leave_balances" ADD CONSTRAINT "fk_leave_balances_leave_type_id_org" FOREIGN KEY (org_id, leave_type_id) REFERENCES "public"."leave_types"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leave_balances_leave_type_id_org'
             AND conrelid = to_regclass('public.leave_balances') AND NOT convalidated) THEN
    ALTER TABLE "public"."leave_balances" VALIDATE CONSTRAINT "fk_leave_balances_leave_type_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.leave_policies') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leave_policies_leave_type_id_org'
                     AND conrelid = to_regclass('public.leave_policies')) THEN
    ALTER TABLE "public"."leave_policies" ADD CONSTRAINT "fk_leave_policies_leave_type_id_org" FOREIGN KEY (org_id, leave_type_id) REFERENCES "public"."leave_types"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leave_policies_leave_type_id_org'
             AND conrelid = to_regclass('public.leave_policies') AND NOT convalidated) THEN
    ALTER TABLE "public"."leave_policies" VALIDATE CONSTRAINT "fk_leave_policies_leave_type_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.leave_requests') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leave_requests_leave_type_id_org'
                     AND conrelid = to_regclass('public.leave_requests')) THEN
    ALTER TABLE "public"."leave_requests" ADD CONSTRAINT "fk_leave_requests_leave_type_id_org" FOREIGN KEY (org_id, leave_type_id) REFERENCES "public"."leave_types"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leave_requests_leave_type_id_org'
             AND conrelid = to_regclass('public.leave_requests') AND NOT convalidated) THEN
    ALTER TABLE "public"."leave_requests" VALIDATE CONSTRAINT "fk_leave_requests_leave_type_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.onboarding_documents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_onboarding_documents_document_type_id_org'
                     AND conrelid = to_regclass('public.onboarding_documents')) THEN
    ALTER TABLE "public"."onboarding_documents" ADD CONSTRAINT "fk_onboarding_documents_document_type_id_org" FOREIGN KEY (org_id, document_type_id) REFERENCES "public"."document_types"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_onboarding_documents_document_type_id_org'
             AND conrelid = to_regclass('public.onboarding_documents') AND NOT convalidated) THEN
    ALTER TABLE "public"."onboarding_documents" VALIDATE CONSTRAINT "fk_onboarding_documents_document_type_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.onboarding_tasks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_onboarding_tasks_template_step_id_org'
                     AND conrelid = to_regclass('public.onboarding_tasks')) THEN
    ALTER TABLE "public"."onboarding_tasks" ADD CONSTRAINT "fk_onboarding_tasks_template_step_id_org" FOREIGN KEY (org_id, template_step_id) REFERENCES "public"."onboarding_template_steps"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_onboarding_tasks_template_step_id_org'
             AND conrelid = to_regclass('public.onboarding_tasks') AND NOT convalidated) THEN
    ALTER TABLE "public"."onboarding_tasks" VALIDATE CONSTRAINT "fk_onboarding_tasks_template_step_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.onboarding_template_steps') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_onboarding_template_steps_template_id_org'
                     AND conrelid = to_regclass('public.onboarding_template_steps')) THEN
    ALTER TABLE "public"."onboarding_template_steps" ADD CONSTRAINT "fk_onboarding_template_steps_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES "public"."onboarding_templates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_onboarding_template_steps_template_id_org'
             AND conrelid = to_regclass('public.onboarding_template_steps') AND NOT convalidated) THEN
    ALTER TABLE "public"."onboarding_template_steps" VALIDATE CONSTRAINT "fk_onboarding_template_steps_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.policy_acknowledgments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_policy_acknowledgments_document_id_org'
                     AND conrelid = to_regclass('public.policy_acknowledgments')) THEN
    ALTER TABLE "public"."policy_acknowledgments" ADD CONSTRAINT "fk_policy_acknowledgments_document_id_org" FOREIGN KEY (org_id, document_id) REFERENCES "public"."documents"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_policy_acknowledgments_document_id_org'
             AND conrelid = to_regclass('public.policy_acknowledgments') AND NOT convalidated) THEN
    ALTER TABLE "public"."policy_acknowledgments" VALIDATE CONSTRAINT "fk_policy_acknowledgments_document_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.roster_entries') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_roster_entries_roster_id_org'
                     AND conrelid = to_regclass('public.roster_entries')) THEN
    ALTER TABLE "public"."roster_entries" ADD CONSTRAINT "fk_roster_entries_roster_id_org" FOREIGN KEY (org_id, roster_id) REFERENCES "public"."rosters"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_roster_entries_roster_id_org'
             AND conrelid = to_regclass('public.roster_entries') AND NOT convalidated) THEN
    ALTER TABLE "public"."roster_entries" VALIDATE CONSTRAINT "fk_roster_entries_roster_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.roster_entries') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_roster_entries_shift_id_org'
                     AND conrelid = to_regclass('public.roster_entries')) THEN
    ALTER TABLE "public"."roster_entries" ADD CONSTRAINT "fk_roster_entries_shift_id_org" FOREIGN KEY (org_id, shift_id) REFERENCES "public"."shift_templates"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_roster_entries_shift_id_org'
             AND conrelid = to_regclass('public.roster_entries') AND NOT convalidated) THEN
    ALTER TABLE "public"."roster_entries" VALIDATE CONSTRAINT "fk_roster_entries_shift_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.team_event_participants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_team_event_participants_event_id_org'
                     AND conrelid = to_regclass('public.team_event_participants')) THEN
    ALTER TABLE "public"."team_event_participants" ADD CONSTRAINT "fk_team_event_participants_event_id_org" FOREIGN KEY (org_id, event_id) REFERENCES "public"."team_events"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_team_event_participants_event_id_org'
             AND conrelid = to_regclass('public.team_event_participants') AND NOT convalidated) THEN
    ALTER TABLE "public"."team_event_participants" VALIDATE CONSTRAINT "fk_team_event_participants_event_id_org";
  END IF;
END $$;
