ALTER TABLE "learning_paths" ADD COLUMN IF NOT EXISTS "level" text;
ALTER TABLE "learning_paths" ADD COLUMN IF NOT EXISTS "estimated_hours" integer;
