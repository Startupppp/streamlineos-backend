ALTER TABLE "intake_items" ADD COLUMN IF NOT EXISTS "submitter_name" text;
ALTER TABLE "intake_items" ADD COLUMN IF NOT EXISTS "priority" text;
ALTER TABLE "intake_items" ADD COLUMN IF NOT EXISTS "request_type" text;
