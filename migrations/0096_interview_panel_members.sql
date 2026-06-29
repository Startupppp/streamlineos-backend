ALTER TABLE "interviews" ADD COLUMN IF NOT EXISTS "panel_interviewer_ids" jsonb DEFAULT '[]';
