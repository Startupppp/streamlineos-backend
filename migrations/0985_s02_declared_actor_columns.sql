-- S02: add the nullable actor columns the Drizzle model declares but no database has, because db.select() renders them and fails 42703 on every full-table read.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "announcement_reads" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "assigned_to_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_helpdesk_routing" ADD COLUMN IF NOT EXISTS "assignee_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_helpdesk_comments" ADD COLUMN IF NOT EXISTS "author_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "employee_devices" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "biometric_logs" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "policy_acknowledgments" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "team_event_participants" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_badge_awards" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_reward_points_ledger" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_poll_votes" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_community_members" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_device_employee_mappings" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_arrears_adjustments" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_comp_recommendations" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_equity_grants" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_accommodation_requests" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_accommodation_tasks" ADD COLUMN IF NOT EXISTS "assignee_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_emergency_responses" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_access_provisioning" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "feedback_cycle_requests" ADD COLUMN IF NOT EXISTS "subject_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "feedback_cycle_requests" ADD COLUMN IF NOT EXISTS "reviewer_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_legal_holds" ADD COLUMN IF NOT EXISTS "subject_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_data_requests" ADD COLUMN IF NOT EXISTS "subject_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_union_memberships" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "interview_panel_members" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "booking_link_interviewers" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "calibration_participants" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "job_recruiters" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_leave_ledger" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "leave_balances" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "onboarding_tasks" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "onboarding_documents" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "exit_checklists" ADD COLUMN IF NOT EXISTS "assigned_to_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "terminations" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "alumni_profiles" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "background_verifications" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "certifications" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD COLUMN IF NOT EXISTS "approver_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "comp_off_balances" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "performance_reviews" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "one_on_one_meetings" ADD COLUMN IF NOT EXISTS "manager_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "one_on_one_meetings" ADD COLUMN IF NOT EXISTS "employee_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "performance_improvement_plans" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "performance_improvement_plans" ADD COLUMN IF NOT EXISTS "manager_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "performance_improvement_plans" ADD COLUMN IF NOT EXISTS "hr_rep_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "survey_responses" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD COLUMN IF NOT EXISTS "subject_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD COLUMN IF NOT EXISTS "reviewer_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "enps_scores" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "employee_skills" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "assessment_attempts" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "hr_calibration_entries" ADD COLUMN IF NOT EXISTS "employee_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "job_requisitions" ADD COLUMN IF NOT EXISTS "hiring_manager_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "job_requisitions" ADD COLUMN IF NOT EXISTS "requested_by_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "job_requisitions" ADD COLUMN IF NOT EXISTS "approver_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "roster_entries" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "employee_shift_assignments" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD COLUMN IF NOT EXISTS "requester_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD COLUMN IF NOT EXISTS "target_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD COLUMN IF NOT EXISTS "approver_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "tax_declarations" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "travel_requests" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "travel_requests" ADD COLUMN IF NOT EXISTS "manager_approver_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "travel_requests" ADD COLUMN IF NOT EXISTS "finance_approver_membership_id" integer;
