-- 0951_ar02_hr_recruitment_composite_fks_2 DOWN — drops every constraint and index the up migration added.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE vendor_candidate_submissions DROP CONSTRAINT IF EXISTS "fk_vendor_candidate_submissions_org_vendor";
--> statement-breakpoint
ALTER TABLE vendor_candidate_submissions DROP CONSTRAINT IF EXISTS "fk_vendor_candidate_submissions_org_job_posting";
--> statement-breakpoint
ALTER TABLE vendor_candidate_submissions DROP CONSTRAINT IF EXISTS "fk_vendor_candidate_submissions_org_candidate";
--> statement-breakpoint
ALTER TABLE vault_access_logs DROP CONSTRAINT IF EXISTS "fk_vault_access_logs_org_candidate";
--> statement-breakpoint
ALTER TABLE vault_access_logs DROP CONSTRAINT IF EXISTS "fk_vault_access_logs_org_vault_document";
--> statement-breakpoint
ALTER TABLE talent_pool_members DROP CONSTRAINT IF EXISTS "fk_talent_pool_members_org_pool";
--> statement-breakpoint
ALTER TABLE talent_pool_members DROP CONSTRAINT IF EXISTS "fk_talent_pool_members_org_candidate";
--> statement-breakpoint
ALTER TABLE roster_entries DROP CONSTRAINT IF EXISTS "fk_roster_entries_org_shift";
--> statement-breakpoint
ALTER TABLE roster_entries DROP CONSTRAINT IF EXISTS "fk_roster_entries_org_roster";
--> statement-breakpoint
ALTER TABLE review_cycles DROP CONSTRAINT IF EXISTS "fk_review_cycles_org_template";
--> statement-breakpoint
ALTER TABLE recruiter_activity_log DROP CONSTRAINT IF EXISTS "fk_recruiter_activity_log_org_job_posting";
--> statement-breakpoint
ALTER TABLE recruiter_activity_log DROP CONSTRAINT IF EXISTS "fk_recruiter_activity_log_org_candidate";
--> statement-breakpoint
ALTER TABLE offer_versions DROP CONSTRAINT IF EXISTS "fk_offer_versions_org_offer";
--> statement-breakpoint
ALTER TABLE offer_negotiations DROP CONSTRAINT IF EXISTS "fk_offer_negotiations_org_offer";
--> statement-breakpoint
ALTER TABLE job_recruiters DROP CONSTRAINT IF EXISTS "fk_job_recruiters_org_job_posting";
--> statement-breakpoint
ALTER TABLE job_postings DROP CONSTRAINT IF EXISTS "fk_job_postings_org_department";
--> statement-breakpoint
ALTER TABLE job_postings DROP CONSTRAINT IF EXISTS "fk_job_postings_org_hiring_flow";
--> statement-breakpoint
ALTER TABLE job_board_postings DROP CONSTRAINT IF EXISTS "fk_job_board_postings_org_job_posting";
--> statement-breakpoint
ALTER TABLE investment_proofs DROP CONSTRAINT IF EXISTS "fk_investment_proofs_org_declaration";
--> statement-breakpoint
ALTER TABLE interview_scorecards DROP CONSTRAINT IF EXISTS "fk_interview_scorecards_org_scorecard_template";
--> statement-breakpoint
ALTER TABLE interview_scorecards DROP CONSTRAINT IF EXISTS "fk_interview_scorecards_org_interview";
--> statement-breakpoint
ALTER TABLE interview_panel_members DROP CONSTRAINT IF EXISTS "fk_interview_panel_members_org_interview";
--> statement-breakpoint
ALTER TABLE interview_booking_links DROP CONSTRAINT IF EXISTS "fk_interview_booking_links_org_job_posting";
--> statement-breakpoint
ALTER TABLE interview_booking_links DROP CONSTRAINT IF EXISTS "fk_interview_booking_links_org_candidate";
--> statement-breakpoint
ALTER TABLE hiring_flow_rounds DROP CONSTRAINT IF EXISTS "fk_hiring_flow_rounds_org_scorecard_template";
--> statement-breakpoint
ALTER TABLE hiring_flow_rounds DROP CONSTRAINT IF EXISTS "fk_hiring_flow_rounds_org_flow";
--> statement-breakpoint
ALTER TABLE headcount_requests DROP CONSTRAINT IF EXISTS "fk_headcount_requests_org_department";
--> statement-breakpoint
ALTER TABLE headcount_requests DROP CONSTRAINT IF EXISTS "fk_headcount_requests_org_job_posting";
--> statement-breakpoint
ALTER TABLE external_referrals DROP CONSTRAINT IF EXISTS "fk_external_referrals_org_job_posting";
--> statement-breakpoint
ALTER TABLE external_referrals DROP CONSTRAINT IF EXISTS "fk_external_referrals_org_referrer";
--> statement-breakpoint
ALTER TABLE external_referrals DROP CONSTRAINT IF EXISTS "fk_external_referrals_org_candidate";
--> statement-breakpoint
ALTER TABLE employee_shift_assignments DROP CONSTRAINT IF EXISTS "fk_employee_shift_assignments_org_shift";
--> statement-breakpoint
ALTER TABLE employee_salary_profile_components DROP CONSTRAINT IF EXISTS "fk_employee_salary_profile_components_org_component";
--> statement-breakpoint
ALTER TABLE employee_salary_profile_components DROP CONSTRAINT IF EXISTS "fk_employee_salary_profile_components_org_profile";
--> statement-breakpoint
ALTER TABLE employee_career_plans DROP CONSTRAINT IF EXISTS "fk_employee_career_plans_org_path";
