SET lock_timeout = '5s';

-- payroll_runs: drop legacy approved_by column (companion approved_by_membership_id added + validated in 0647)
ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS payroll_runs_approved_by_users_id_fk;
ALTER TABLE payroll_runs DROP COLUMN IF EXISTS approved_by;

-- payroll_approvals: drop legacy acted_by column (companion acted_by_membership_id added + validated in 0647)
ALTER TABLE payroll_approvals DROP CONSTRAINT IF EXISTS payroll_approvals_acted_by_users_id_fk;
ALTER TABLE payroll_approvals DROP COLUMN IF EXISTS acted_by;
