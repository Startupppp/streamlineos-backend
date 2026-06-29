-- Add task dependencies to onboarding_tasks
ALTER TABLE "onboarding_tasks" ADD COLUMN IF NOT EXISTS "depends_on_task_ids" jsonb DEFAULT '[]'::jsonb;
