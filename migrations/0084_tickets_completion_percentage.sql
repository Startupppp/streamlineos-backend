-- Add completion_percentage to tickets for sub-task progress tracking
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "completion_percentage" integer DEFAULT 0;
