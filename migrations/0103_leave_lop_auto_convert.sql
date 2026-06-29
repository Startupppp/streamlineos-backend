-- Auto-convert excess leave to LOP (Loss of Pay)
-- Adds lop_days column to track how many days in a leave request were converted to LOP

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS lop_days numeric(5,1) NOT NULL DEFAULT '0';
