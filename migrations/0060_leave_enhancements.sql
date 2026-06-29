-- Add CANCELLED to leave_status enum
ALTER TYPE "leave_status" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- Add new columns to leave_requests
ALTER TABLE "leave_requests"
  ADD COLUMN IF NOT EXISTS "is_half_day" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "half_day_period" text,
  ADD COLUMN IF NOT EXISTS "manager_comment" text,
  ADD COLUMN IF NOT EXISTS "covering_employee_id" text REFERENCES "users"("id") ON DELETE SET NULL;
