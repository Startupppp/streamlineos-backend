-- Add REJECTED value to resignation_status enum
ALTER TYPE resignation_status ADD VALUE IF NOT EXISTS 'REJECTED';
