ALTER TABLE "project_meetings"
  ADD COLUMN IF NOT EXISTS "end_at" timestamp,
  ADD COLUMN IF NOT EXISTS "timezone" text,
  ADD COLUMN IF NOT EXISTS "recurrence_rule" jsonb;
