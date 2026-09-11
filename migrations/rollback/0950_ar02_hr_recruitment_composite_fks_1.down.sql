-- 0950_ar02_hr_recruitment_composite_fks_1 DOWN — drops every constraint and index the up migration added.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE email_sequence_enrollments DROP CONSTRAINT IF EXISTS "fk_email_sequence_enrollments_org_sequence";
--> statement-breakpoint
ALTER TABLE email_sequence_enrollments DROP CONSTRAINT IF EXISTS "fk_email_sequence_enrollments_org_candidate";
--> statement-breakpoint
ALTER TABLE candidate_sla_tracking DROP CONSTRAINT IF EXISTS "fk_candidate_sla_tracking_org_candidate";
--> statement-breakpoint
ALTER TABLE candidate_resumes DROP CONSTRAINT IF EXISTS "fk_candidate_resumes_org_candidate";
--> statement-breakpoint
ALTER TABLE candidate_referrals DROP CONSTRAINT IF EXISTS "fk_candidate_referrals_org_job_posting";
--> statement-breakpoint
ALTER TABLE candidate_referrals DROP CONSTRAINT IF EXISTS "fk_candidate_referrals_org_candidate";
--> statement-breakpoint
ALTER TABLE candidate_reference_checks DROP CONSTRAINT IF EXISTS "fk_candidate_reference_checks_org_candidate";
--> statement-breakpoint
ALTER TABLE candidate_offers DROP CONSTRAINT IF EXISTS "fk_candidate_offers_org_job_posting";
--> statement-breakpoint
ALTER TABLE candidate_offers DROP CONSTRAINT IF EXISTS "fk_candidate_offers_org_candidate";
--> statement-breakpoint
ALTER TABLE candidate_messages DROP CONSTRAINT IF EXISTS "fk_candidate_messages_org_candidate";
--> statement-breakpoint
ALTER TABLE candidate_documents_vault DROP CONSTRAINT IF EXISTS "fk_candidate_documents_vault_org_candidate";
--> statement-breakpoint
ALTER TABLE candidate_documents DROP CONSTRAINT IF EXISTS "fk_candidate_documents_org_template";
--> statement-breakpoint
ALTER TABLE candidate_documents DROP CONSTRAINT IF EXISTS "fk_candidate_documents_org_candidate";
--> statement-breakpoint
ALTER TABLE candidate_applications DROP CONSTRAINT IF EXISTS "fk_candidate_applications_org_job_posting";
--> statement-breakpoint
ALTER TABLE candidate_applications DROP CONSTRAINT IF EXISTS "fk_candidate_applications_org_candidate";
--> statement-breakpoint
ALTER TABLE calibration_sessions DROP CONSTRAINT IF EXISTS "fk_calibration_sessions_org_job_posting";
--> statement-breakpoint
ALTER TABLE calibration_sessions DROP CONSTRAINT IF EXISTS "fk_calibration_sessions_org_candidate";
--> statement-breakpoint
ALTER TABLE calibration_participants DROP CONSTRAINT IF EXISTS "fk_calibration_participants_org_session";
--> statement-breakpoint
ALTER TABLE booking_link_interviewers DROP CONSTRAINT IF EXISTS "fk_booking_link_interviewers_org_booking_link";
