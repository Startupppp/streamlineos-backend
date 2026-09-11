-- 0985 DOWN — drops the columns this migration added. They carry no data before it runs, so this is lossless only immediately after; afterwards it is data-destructive.
-- @data-loss

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "announcement_reads" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN IF EXISTS "assigned_to_membership_id";
--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_helpdesk_routing" DROP COLUMN IF EXISTS "assignee_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_helpdesk_comments" DROP COLUMN IF EXISTS "author_membership_id";
--> statement-breakpoint
ALTER TABLE "employee_devices" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "biometric_logs" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "policy_acknowledgments" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "team_event_participants" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_badge_awards" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_reward_points_ledger" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_poll_votes" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_community_members" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_device_employee_mappings" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_arrears_adjustments" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_comp_recommendations" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_equity_grants" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_accommodation_requests" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_accommodation_tasks" DROP COLUMN IF EXISTS "assignee_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_emergency_responses" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_access_provisioning" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "feedback_cycle_requests" DROP COLUMN IF EXISTS "subject_membership_id";
--> statement-breakpoint
ALTER TABLE "feedback_cycle_requests" DROP COLUMN IF EXISTS "reviewer_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_legal_holds" DROP COLUMN IF EXISTS "subject_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_data_requests" DROP COLUMN IF EXISTS "subject_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_union_memberships" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "interview_panel_members" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "booking_link_interviewers" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "calibration_participants" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "job_recruiters" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_leave_ledger" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "leave_balances" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "onboarding_tasks" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "onboarding_documents" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "exit_checklists" DROP COLUMN IF EXISTS "assigned_to_membership_id";
--> statement-breakpoint
ALTER TABLE "terminations" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "alumni_profiles" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "background_verifications" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "certifications" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "overtime_requests" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "overtime_requests" DROP COLUMN IF EXISTS "approver_membership_id";
--> statement-breakpoint
ALTER TABLE "comp_off_balances" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "performance_reviews" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "one_on_one_meetings" DROP COLUMN IF EXISTS "manager_membership_id";
--> statement-breakpoint
ALTER TABLE "one_on_one_meetings" DROP COLUMN IF EXISTS "employee_membership_id";
--> statement-breakpoint
ALTER TABLE "goals" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "performance_improvement_plans" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "performance_improvement_plans" DROP COLUMN IF EXISTS "manager_membership_id";
--> statement-breakpoint
ALTER TABLE "performance_improvement_plans" DROP COLUMN IF EXISTS "hr_rep_membership_id";
--> statement-breakpoint
ALTER TABLE "survey_responses" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "feedback_requests" DROP COLUMN IF EXISTS "subject_membership_id";
--> statement-breakpoint
ALTER TABLE "feedback_requests" DROP COLUMN IF EXISTS "reviewer_membership_id";
--> statement-breakpoint
ALTER TABLE "enps_scores" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "employee_skills" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "assessment_attempts" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "hr_calibration_entries" DROP COLUMN IF EXISTS "employee_membership_id";
--> statement-breakpoint
ALTER TABLE "job_requisitions" DROP COLUMN IF EXISTS "hiring_manager_membership_id";
--> statement-breakpoint
ALTER TABLE "job_requisitions" DROP COLUMN IF EXISTS "requested_by_membership_id";
--> statement-breakpoint
ALTER TABLE "job_requisitions" DROP COLUMN IF EXISTS "approver_membership_id";
--> statement-breakpoint
ALTER TABLE "roster_entries" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "employee_shift_assignments" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "shift_swap_requests" DROP COLUMN IF EXISTS "requester_membership_id";
--> statement-breakpoint
ALTER TABLE "shift_swap_requests" DROP COLUMN IF EXISTS "target_membership_id";
--> statement-breakpoint
ALTER TABLE "shift_swap_requests" DROP COLUMN IF EXISTS "approver_membership_id";
--> statement-breakpoint
ALTER TABLE "tax_declarations" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "travel_requests" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "travel_requests" DROP COLUMN IF EXISTS "manager_approver_membership_id";
--> statement-breakpoint
ALTER TABLE "travel_requests" DROP COLUMN IF EXISTS "finance_approver_membership_id";
