ALTER TABLE "project_statuses" ADD COLUMN IF NOT EXISTS "type" text DEFAULT 'unstarted';
