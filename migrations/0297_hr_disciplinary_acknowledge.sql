-- Phase 9.2: employee acknowledgment of disciplinary actions
ALTER TABLE hr_disciplinary_actions
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamp,
  ADD COLUMN IF NOT EXISTS acknowledged_by text REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_hr_disciplinary_ack
  ON hr_disciplinary_actions (org_id, employee_id)
  WHERE acknowledged_at IS NULL;
