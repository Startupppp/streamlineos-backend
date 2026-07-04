-- PRD 11 (Candidate Intake And Public Apply) — Application Form Builder.
-- Additive nullable jsonb columns: job_postings.screening_questions (admin-defined
-- question set) and candidate_applications.screening_answers (applicant responses).

BEGIN;

ALTER TABLE "job_postings" ADD COLUMN "screening_questions" jsonb;
ALTER TABLE "candidate_applications" ADD COLUMN "screening_answers" jsonb;

COMMIT;
