-- AR-02: composite tenant FKs — HR/recruitment cluster part 2
-- Covers: employee_*, external_referrals, headcount_requests, hiring_flow_rounds,
--         interview_booking_links, interview_panel_members, interview_scorecards,
--         investment_proofs, job_board_postings, job_postings, job_recruiters,
--         offer_negotiations, offer_versions, recruiter_activity_log, review_cycles,
--         roster_entries, talent_pool_members, vault_access_logs, vendor_candidate_submissions

SET lock_timeout = DEFAULT;

ALTER TABLE employee_career_plans
  ADD CONSTRAINT fk_employee_career_plans_org_path
  FOREIGN KEY (org_id, path_id)
  REFERENCES career_paths (org_id, id)
  ON DELETE SET NULL (path_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE employee_career_plans VALIDATE CONSTRAINT fk_employee_career_plans_org_path;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE employee_salary_profile_components
  ADD CONSTRAINT fk_employee_salary_profile_components_org_profile
  FOREIGN KEY (org_id, profile_id)
  REFERENCES employee_salary_profiles (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE employee_salary_profile_components VALIDATE CONSTRAINT fk_employee_salary_profile_components_org_profile;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE employee_salary_profile_components
  ADD CONSTRAINT fk_employee_salary_profile_components_org_component
  FOREIGN KEY (org_id, component_id)
  REFERENCES salary_components (org_id, id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE employee_salary_profile_components VALIDATE CONSTRAINT fk_employee_salary_profile_components_org_component;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE employee_shift_assignments
  ADD CONSTRAINT fk_employee_shift_assignments_org_shift
  FOREIGN KEY (org_id, shift_id)
  REFERENCES shift_templates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE employee_shift_assignments VALIDATE CONSTRAINT fk_employee_shift_assignments_org_shift;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE external_referrals
  ADD CONSTRAINT fk_external_referrals_org_candidate
  FOREIGN KEY (org_id, candidate_id)
  REFERENCES candidates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE external_referrals VALIDATE CONSTRAINT fk_external_referrals_org_candidate;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE external_referrals
  ADD CONSTRAINT fk_external_referrals_org_referrer
  FOREIGN KEY (org_id, referrer_id)
  REFERENCES external_referrers (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE external_referrals VALIDATE CONSTRAINT fk_external_referrals_org_referrer;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE external_referrals
  ADD CONSTRAINT fk_external_referrals_org_job_posting
  FOREIGN KEY (org_id, job_posting_id)
  REFERENCES job_postings (org_id, id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE external_referrals VALIDATE CONSTRAINT fk_external_referrals_org_job_posting;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE headcount_requests
  ADD CONSTRAINT fk_headcount_requests_org_job_posting
  FOREIGN KEY (org_id, linked_job_posting_id)
  REFERENCES job_postings (org_id, id)
  ON DELETE SET NULL (linked_job_posting_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE headcount_requests VALIDATE CONSTRAINT fk_headcount_requests_org_job_posting;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE headcount_requests
  ADD CONSTRAINT fk_headcount_requests_org_department
  FOREIGN KEY (org_id, org_department_id)
  REFERENCES org_units (org_id, id)
  ON DELETE SET NULL (org_department_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE headcount_requests VALIDATE CONSTRAINT fk_headcount_requests_org_department;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hiring_flow_rounds
  ADD CONSTRAINT fk_hiring_flow_rounds_org_flow
  FOREIGN KEY (org_id, flow_id)
  REFERENCES hiring_flows (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hiring_flow_rounds VALIDATE CONSTRAINT fk_hiring_flow_rounds_org_flow;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hiring_flow_rounds
  ADD CONSTRAINT fk_hiring_flow_rounds_org_scorecard_template
  FOREIGN KEY (org_id, scorecard_template_id)
  REFERENCES scorecard_templates (org_id, id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hiring_flow_rounds VALIDATE CONSTRAINT fk_hiring_flow_rounds_org_scorecard_template;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE interview_booking_links
  ADD CONSTRAINT fk_interview_booking_links_org_candidate
  FOREIGN KEY (org_id, candidate_id)
  REFERENCES candidates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE interview_booking_links VALIDATE CONSTRAINT fk_interview_booking_links_org_candidate;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE interview_booking_links
  ADD CONSTRAINT fk_interview_booking_links_org_job_posting
  FOREIGN KEY (org_id, job_posting_id)
  REFERENCES job_postings (org_id, id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE interview_booking_links VALIDATE CONSTRAINT fk_interview_booking_links_org_job_posting;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE interview_panel_members
  ADD CONSTRAINT fk_interview_panel_members_org_interview
  FOREIGN KEY (org_id, interview_id)
  REFERENCES interviews (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE interview_panel_members VALIDATE CONSTRAINT fk_interview_panel_members_org_interview;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE interview_scorecards
  ADD CONSTRAINT fk_interview_scorecards_org_interview
  FOREIGN KEY (org_id, interview_id)
  REFERENCES interviews (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE interview_scorecards VALIDATE CONSTRAINT fk_interview_scorecards_org_interview;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE interview_scorecards
  ADD CONSTRAINT fk_interview_scorecards_org_scorecard_template
  FOREIGN KEY (org_id, template_id)
  REFERENCES scorecard_templates (org_id, id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE interview_scorecards VALIDATE CONSTRAINT fk_interview_scorecards_org_scorecard_template;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE investment_proofs
  ADD CONSTRAINT fk_investment_proofs_org_declaration
  FOREIGN KEY (org_id, declaration_id)
  REFERENCES tax_declarations (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE investment_proofs VALIDATE CONSTRAINT fk_investment_proofs_org_declaration;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE job_board_postings
  ADD CONSTRAINT fk_job_board_postings_org_job_posting
  FOREIGN KEY (org_id, job_posting_id)
  REFERENCES job_postings (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE job_board_postings VALIDATE CONSTRAINT fk_job_board_postings_org_job_posting;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE job_postings
  ADD CONSTRAINT fk_job_postings_org_hiring_flow
  FOREIGN KEY (org_id, hiring_flow_id)
  REFERENCES hiring_flows (org_id, id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE job_postings VALIDATE CONSTRAINT fk_job_postings_org_hiring_flow;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE job_postings
  ADD CONSTRAINT fk_job_postings_org_department
  FOREIGN KEY (org_id, org_department_id)
  REFERENCES org_units (org_id, id)
  ON DELETE SET NULL (org_department_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE job_postings VALIDATE CONSTRAINT fk_job_postings_org_department;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE job_recruiters
  ADD CONSTRAINT fk_job_recruiters_org_job_posting
  FOREIGN KEY (org_id, job_posting_id)
  REFERENCES job_postings (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE job_recruiters VALIDATE CONSTRAINT fk_job_recruiters_org_job_posting;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE offer_negotiations
  ADD CONSTRAINT fk_offer_negotiations_org_offer
  FOREIGN KEY (org_id, offer_id)
  REFERENCES candidate_offers (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE offer_negotiations VALIDATE CONSTRAINT fk_offer_negotiations_org_offer;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE offer_versions
  ADD CONSTRAINT fk_offer_versions_org_offer
  FOREIGN KEY (org_id, offer_id)
  REFERENCES candidate_offers (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE offer_versions VALIDATE CONSTRAINT fk_offer_versions_org_offer;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE recruiter_activity_log
  ADD CONSTRAINT fk_recruiter_activity_log_org_candidate
  FOREIGN KEY (org_id, candidate_id)
  REFERENCES candidates (org_id, id)
  ON DELETE SET NULL (candidate_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE recruiter_activity_log VALIDATE CONSTRAINT fk_recruiter_activity_log_org_candidate;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE recruiter_activity_log
  ADD CONSTRAINT fk_recruiter_activity_log_org_job_posting
  FOREIGN KEY (org_id, job_posting_id)
  REFERENCES job_postings (org_id, id)
  ON DELETE SET NULL (job_posting_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE recruiter_activity_log VALIDATE CONSTRAINT fk_recruiter_activity_log_org_job_posting;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE review_cycles
  ADD CONSTRAINT fk_review_cycles_org_template
  FOREIGN KEY (org_id, template_id)
  REFERENCES hr_templates (org_id, id)
  ON DELETE SET NULL (template_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE review_cycles VALIDATE CONSTRAINT fk_review_cycles_org_template;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE roster_entries
  ADD CONSTRAINT fk_roster_entries_org_roster
  FOREIGN KEY (org_id, roster_id)
  REFERENCES rosters (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE roster_entries VALIDATE CONSTRAINT fk_roster_entries_org_roster;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE roster_entries
  ADD CONSTRAINT fk_roster_entries_org_shift
  FOREIGN KEY (org_id, shift_id)
  REFERENCES shift_templates (org_id, id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE roster_entries VALIDATE CONSTRAINT fk_roster_entries_org_shift;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE talent_pool_members
  ADD CONSTRAINT fk_talent_pool_members_org_candidate
  FOREIGN KEY (org_id, candidate_id)
  REFERENCES candidates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE talent_pool_members VALIDATE CONSTRAINT fk_talent_pool_members_org_candidate;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE talent_pool_members
  ADD CONSTRAINT fk_talent_pool_members_org_pool
  FOREIGN KEY (org_id, pool_id)
  REFERENCES talent_pools (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE talent_pool_members VALIDATE CONSTRAINT fk_talent_pool_members_org_pool;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE vault_access_logs
  ADD CONSTRAINT fk_vault_access_logs_org_vault_document
  FOREIGN KEY (org_id, vault_document_id)
  REFERENCES candidate_documents_vault (org_id, id)
  ON DELETE SET NULL (vault_document_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE vault_access_logs VALIDATE CONSTRAINT fk_vault_access_logs_org_vault_document;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE vault_access_logs
  ADD CONSTRAINT fk_vault_access_logs_org_candidate
  FOREIGN KEY (org_id, candidate_id)
  REFERENCES candidates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE vault_access_logs VALIDATE CONSTRAINT fk_vault_access_logs_org_candidate;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE vendor_candidate_submissions
  ADD CONSTRAINT fk_vendor_candidate_submissions_org_candidate
  FOREIGN KEY (org_id, candidate_id)
  REFERENCES candidates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE vendor_candidate_submissions VALIDATE CONSTRAINT fk_vendor_candidate_submissions_org_candidate;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE vendor_candidate_submissions
  ADD CONSTRAINT fk_vendor_candidate_submissions_org_job_posting
  FOREIGN KEY (org_id, job_posting_id)
  REFERENCES job_postings (org_id, id)
  ON DELETE SET NULL (job_posting_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE vendor_candidate_submissions VALIDATE CONSTRAINT fk_vendor_candidate_submissions_org_job_posting;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE vendor_candidate_submissions
  ADD CONSTRAINT fk_vendor_candidate_submissions_org_vendor
  FOREIGN KEY (org_id, vendor_id)
  REFERENCES recruitment_vendors (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE vendor_candidate_submissions VALIDATE CONSTRAINT fk_vendor_candidate_submissions_org_vendor;
SET lock_timeout = DEFAULT;
