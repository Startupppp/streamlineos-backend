ALTER TABLE "interview_questions" ADD COLUMN IF NOT EXISTS "sample_answer" text;
ALTER TABLE "interview_questions" ADD COLUMN IF NOT EXISTS "keywords" text[];
