-- 0647_pay_time_actor_membership_expand
-- Expand-only: adds membership-identity columns alongside legacy user-id columns.
SET lock_timeout = '5s';

ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS approved_by_membership_id integer;
--> statement-breakpoint
UPDATE payroll_runs t
  SET approved_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.approved_by
    AND t.approved_by_membership_id IS NULL;
--> statement-breakpoint
ALTER TABLE payroll_runs ADD CONSTRAINT fk_payroll_runs_approved_actor
  FOREIGN KEY (org_id, approved_by_membership_id)
  REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE payroll_runs VALIDATE CONSTRAINT fk_payroll_runs_approved_actor;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_payroll_runs_org_approved_actor ON payroll_runs (org_id, approved_by_membership_id);
--> statement-breakpoint

ALTER TABLE payroll_approvals ADD COLUMN IF NOT EXISTS acted_by_membership_id integer;
--> statement-breakpoint
UPDATE payroll_approvals t
  SET acted_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.acted_by
    AND t.acted_by_membership_id IS NULL;
--> statement-breakpoint
ALTER TABLE payroll_approvals ADD CONSTRAINT fk_payroll_approvals_acted_actor
  FOREIGN KEY (org_id, acted_by_membership_id)
  REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE payroll_approvals VALIDATE CONSTRAINT fk_payroll_approvals_acted_actor;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_payroll_approvals_org_acted_actor ON payroll_approvals (org_id, acted_by_membership_id);
--> statement-breakpoint

ALTER TABLE timesheet_periods ADD COLUMN IF NOT EXISTS approved_by_membership_id integer;
--> statement-breakpoint
UPDATE timesheet_periods t
  SET approved_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.approved_by
    AND t.approved_by_membership_id IS NULL;
--> statement-breakpoint
ALTER TABLE timesheet_periods ADD CONSTRAINT fk_timesheet_periods_approved_actor
  FOREIGN KEY (org_id, approved_by_membership_id)
  REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE timesheet_periods VALIDATE CONSTRAINT fk_timesheet_periods_approved_actor;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_timesheet_periods_org_approved_actor ON timesheet_periods (org_id, approved_by_membership_id);
--> statement-breakpoint

ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS approved_by_membership_id integer;
--> statement-breakpoint
UPDATE timesheets t
  SET approved_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.approved_by
    AND t.approved_by_membership_id IS NULL;
--> statement-breakpoint
ALTER TABLE timesheets ADD CONSTRAINT fk_timesheets_approved_actor
  FOREIGN KEY (org_id, approved_by_membership_id)
  REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE timesheets VALIDATE CONSTRAINT fk_timesheets_approved_actor;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_timesheets_org_approved_actor ON timesheets (org_id, approved_by_membership_id);
--> statement-breakpoint

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS approver_membership_id integer;
--> statement-breakpoint
UPDATE expenses t
  SET approver_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.approver_id
    AND t.approver_membership_id IS NULL;
--> statement-breakpoint
ALTER TABLE expenses ADD CONSTRAINT fk_expenses_approver_actor
  FOREIGN KEY (org_id, approver_membership_id)
  REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE expenses VALIDATE CONSTRAINT fk_expenses_approver_actor;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_expenses_org_approver_actor ON expenses (org_id, approver_membership_id);
--> statement-breakpoint

ALTER TABLE reimbursements ADD COLUMN IF NOT EXISTS approved_by_membership_id integer;
--> statement-breakpoint
UPDATE reimbursements t
  SET approved_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.approved_by
    AND t.approved_by_membership_id IS NULL;
--> statement-breakpoint
ALTER TABLE reimbursements ADD CONSTRAINT fk_reimbursements_approved_actor
  FOREIGN KEY (org_id, approved_by_membership_id)
  REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE reimbursements VALIDATE CONSTRAINT fk_reimbursements_approved_actor;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_reimbursements_org_approved_actor ON reimbursements (org_id, approved_by_membership_id);
