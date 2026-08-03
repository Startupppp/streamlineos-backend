ALTER TABLE "automation_rules" ALTER COLUMN "trigger_event" TYPE text;
ALTER TABLE "automation_runs" ALTER COLUMN "status" TYPE text;
ALTER TABLE "hr_automation_runs" ALTER COLUMN "status" TYPE text;

DROP TYPE IF EXISTS "automation_trigger";
DROP TYPE IF EXISTS "automation_run_status";
DROP TYPE IF EXISTS "hr_automation_run_status";
