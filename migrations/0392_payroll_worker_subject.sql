SET statement_timeout = 0;
SET lock_timeout = '5s';

ALTER TABLE employee_salary_profiles
  ADD COLUMN IF NOT EXISTS worker_id text;
--> statement-breakpoint

ALTER TABLE payroll_run_employees
  ADD COLUMN IF NOT EXISTS worker_id text;
--> statement-breakpoint

UPDATE employee_salary_profiles AS esp
SET worker_id = w.worker_id
FROM workers AS w
INNER JOIN organization_people AS op
  ON op.organization_person_id = w.organization_person_id
 AND op.organization_id = w.organization_id
WHERE esp.org_id = w.organization_id
  AND esp.user_id IS NOT NULL
  AND esp.user_id = op.user_id
  AND esp.worker_id IS NULL
  AND w.deleted_at IS NULL;
--> statement-breakpoint

UPDATE payroll_run_employees AS pre
SET worker_id = esp.worker_id
FROM employee_salary_profiles AS esp
WHERE pre.org_id = esp.org_id
  AND pre.profile_id = esp.id
  AND pre.worker_id IS NULL
  AND esp.worker_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE employee_salary_profiles
  ALTER COLUMN user_id DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE payroll_run_employees
  ALTER COLUMN user_id DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE employee_salary_profiles
  ADD CONSTRAINT chk_employee_salary_profiles_subject
  CHECK (user_id IS NOT NULL OR worker_id IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE payroll_run_employees
  ADD CONSTRAINT chk_payroll_run_employees_subject
  CHECK (user_id IS NOT NULL OR worker_id IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE employee_salary_profiles
  ADD CONSTRAINT fk_employee_salary_profiles_org_worker
  FOREIGN KEY (org_id, worker_id)
  REFERENCES workers (organization_id, worker_id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint

ALTER TABLE payroll_run_employees
  ADD CONSTRAINT fk_payroll_run_employees_org_worker
  FOREIGN KEY (org_id, worker_id)
  REFERENCES workers (organization_id, worker_id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_esp_org_worker_effective_from
  ON employee_salary_profiles (org_id, worker_id, effective_from)
  WHERE worker_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_payroll_run_employees_run_worker
  ON payroll_run_employees (run_id, worker_id)
  WHERE worker_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_employee_salary_profiles_org_worker
  ON employee_salary_profiles (org_id, worker_id)
  WHERE worker_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_payroll_run_employees_org_worker
  ON payroll_run_employees (org_id, worker_id)
  WHERE worker_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE employee_salary_profiles
  VALIDATE CONSTRAINT chk_employee_salary_profiles_subject;
--> statement-breakpoint

ALTER TABLE payroll_run_employees
  VALIDATE CONSTRAINT chk_payroll_run_employees_subject;
--> statement-breakpoint

ALTER TABLE employee_salary_profiles
  VALIDATE CONSTRAINT fk_employee_salary_profiles_org_worker;
--> statement-breakpoint

ALTER TABLE payroll_run_employees
  VALIDATE CONSTRAINT fk_payroll_run_employees_org_worker;
