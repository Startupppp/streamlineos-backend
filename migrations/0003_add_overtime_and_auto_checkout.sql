-- Add auto_checked_out to attendance table
ALTER TABLE "attendance" ADD COLUMN "auto_checked_out" boolean DEFAULT false;

-- Add overtime fields to payrolls table
ALTER TABLE "payrolls" ADD COLUMN "overtime_type" text;
ALTER TABLE "payrolls" ADD COLUMN "overtime_days" numeric DEFAULT '0';
ALTER TABLE "payrolls" ADD COLUMN "overtime_hours" numeric DEFAULT '0';
ALTER TABLE "payrolls" ADD COLUMN "overtime_amount" numeric DEFAULT '0';

-- Index for auto-checkout cron performance
CREATE INDEX IF NOT EXISTS "idx_attendance_date_checkout" ON "attendance" ("date", "check_out");
