-- AR-02: composite tenant FKs — HR/recruitment cluster part 1
-- Covers: booking_link_interviewers, calibration_participants, calibration_sessions,
--         candidate_*, email_sequence_enrollments
-- NOT VALID + VALIDATE pattern keeps lock window minimal.

SET lock_timeout = DEFAULT;

ALTER TABLE booking_link_interviewers
  ADD CONSTRAINT fk_booking_link_interviewers_org_booking_link
  FOREIGN KEY (org_id, booking_link_id)
  REFERENCES interview_booking_links (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE booking_link_interviewers VALIDATE CONSTRAINT fk_booking_link_interviewers_org_booking_link;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE calibration_participants
  ADD CONSTRAINT fk_calibration_participants_org_session
  FOREIGN KEY (org_id, session_id)
  REFERENCES calibration_sessions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE calibration_participants VALIDATE CONSTRAINT fk_calibration_participants_org_session;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE calibration_sessions
  ADD CONSTRAINT fk_calibration_sessions_org_candidate
  FOREIGN KEY (org_id, candidate_id)
  REFERENCES candidates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE calibration_sessions VALIDATE CONSTRAINT fk_calibration_sessions_org_candidate;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE calibration_sessions
  ADD CONSTRAINT fk_calibration_sessions_org_job_posting
  FOREIGN KEY (org_id, job_posting_id)
  REFERENCES job_postings (org_id, id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE calibration_sessions VALIDATE CONSTRAINT fk_calibration_sessions_org_job_posting;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE candidate_applications
  ADD CONSTRAINT fk_candidate_applications_org_candidate
  FOREIGN KEY (org_id, candidate_id)
  REFERENCES candidates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE candidate_applications VALIDATE CONSTRAINT fk_candidate_applications_org_candidate;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE candidate_applications
  ADD CONSTRAINT fk_candidate_applications_org_job_posting
  FOREIGN KEY (org_id, job_posting_id)
  REFERENCES job_postings (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE candidate_applications VALIDATE CONSTRAINT fk_candidate_applications_org_job_posting;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE candidate_documents
  ADD CONSTRAINT fk_candidate_documents_org_candidate
  FOREIGN KEY (org_id, candidate_id)
  REFERENCES candidates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE candidate_documents VALIDATE CONSTRAINT fk_candidate_documents_org_candidate;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE candidate_documents
  ADD CONSTRAINT fk_candidate_documents_org_template
  FOREIGN KEY (org_id, template_id)
  REFERENCES document_templates (org_id, id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE candidate_documents VALIDATE CONSTRAINT fk_candidate_documents_org_template;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE candidate_documents_vault
  ADD CONSTRAINT fk_candidate_documents_vault_org_candidate
  FOREIGN KEY (org_id, candidate_id)
  REFERENCES candidates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE candidate_documents_vault VALIDATE CONSTRAINT fk_candidate_documents_vault_org_candidate;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE candidate_messages
  ADD CONSTRAINT fk_candidate_messages_org_candidate
  FOREIGN KEY (org_id, candidate_id)
  REFERENCES candidates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE candidate_messages VALIDATE CONSTRAINT fk_candidate_messages_org_candidate;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE candidate_offers
  ADD CONSTRAINT fk_candidate_offers_org_candidate
  FOREIGN KEY (org_id, candidate_id)
  REFERENCES candidates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE candidate_offers VALIDATE CONSTRAINT fk_candidate_offers_org_candidate;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE candidate_offers
  ADD CONSTRAINT fk_candidate_offers_org_job_posting
  FOREIGN KEY (org_id, job_posting_id)
  REFERENCES job_postings (org_id, id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE candidate_offers VALIDATE CONSTRAINT fk_candidate_offers_org_job_posting;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE candidate_reference_checks
  ADD CONSTRAINT fk_candidate_reference_checks_org_candidate
  FOREIGN KEY (org_id, candidate_id)
  REFERENCES candidates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE candidate_reference_checks VALIDATE CONSTRAINT fk_candidate_reference_checks_org_candidate;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE candidate_referrals
  ADD CONSTRAINT fk_candidate_referrals_org_candidate
  FOREIGN KEY (org_id, candidate_id)
  REFERENCES candidates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE candidate_referrals VALIDATE CONSTRAINT fk_candidate_referrals_org_candidate;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE candidate_referrals
  ADD CONSTRAINT fk_candidate_referrals_org_job_posting
  FOREIGN KEY (org_id, job_posting_id)
  REFERENCES job_postings (org_id, id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE candidate_referrals VALIDATE CONSTRAINT fk_candidate_referrals_org_job_posting;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE candidate_resumes
  ADD CONSTRAINT fk_candidate_resumes_org_candidate
  FOREIGN KEY (org_id, candidate_id)
  REFERENCES candidates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE candidate_resumes VALIDATE CONSTRAINT fk_candidate_resumes_org_candidate;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE candidate_sla_tracking
  ADD CONSTRAINT fk_candidate_sla_tracking_org_candidate
  FOREIGN KEY (org_id, candidate_id)
  REFERENCES candidates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE candidate_sla_tracking VALIDATE CONSTRAINT fk_candidate_sla_tracking_org_candidate;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE email_sequence_enrollments
  ADD CONSTRAINT fk_email_sequence_enrollments_org_candidate
  FOREIGN KEY (org_id, candidate_id)
  REFERENCES candidates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE email_sequence_enrollments VALIDATE CONSTRAINT fk_email_sequence_enrollments_org_candidate;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE email_sequence_enrollments
  ADD CONSTRAINT fk_email_sequence_enrollments_org_sequence
  FOREIGN KEY (org_id, sequence_id)
  REFERENCES email_sequences (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE email_sequence_enrollments VALIDATE CONSTRAINT fk_email_sequence_enrollments_org_sequence;
SET lock_timeout = DEFAULT;
