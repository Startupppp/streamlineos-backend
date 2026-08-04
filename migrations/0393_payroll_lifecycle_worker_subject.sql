SET statement_timeout = 0;
SET lock_timeout = '5s';

ALTER TABLE payslip_publications
  ADD COLUMN IF NOT EXISTS worker_id text;
--> statement-breakpoint

ALTER TABLE payroll_bank_batch_items
  ADD COLUMN IF NOT EXISTS worker_id text;
--> statement-breakpoint

ALTER TABLE payroll_tds_ytd_ledger
  ADD COLUMN IF NOT EXISTS worker_id text;
--> statement-breakpoint

UPDATE payslip_publications AS pp
SET worker_id = pre.worker_id
FROM payroll_run_employees AS pre
WHERE pp.run_employee_id = pre.id
  AND pp.org_id = pre.org_id
  AND pp.worker_id IS NULL
  AND pre.worker_id IS NOT NULL;
--> statement-breakpoint

UPDATE payroll_bank_batch_items AS pbi
SET worker_id = pre.worker_id
FROM payroll_run_employees AS pre
WHERE pbi.run_employee_id = pre.id
  AND pbi.org_id = pre.org_id
  AND pbi.worker_id IS NULL
  AND pre.worker_id IS NOT NULL;
--> statement-breakpoint

UPDATE payroll_tds_ytd_ledger AS ledger
SET worker_id = pre.worker_id
FROM payroll_run_employees AS pre
WHERE ledger.run_id = pre.run_id
  AND ledger.org_id = pre.org_id
  AND ledger.user_id = pre.user_id
  AND ledger.worker_id IS NULL
  AND pre.worker_id IS NOT NULL
  AND pre.user_id IS NULL;
--> statement-breakpoint

ALTER TABLE payslip_publications
  ALTER COLUMN user_id DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE payroll_bank_batch_items
  ALTER COLUMN user_id DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE payroll_tds_ytd_ledger
  ALTER COLUMN user_id DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE payslip_publications
  ADD CONSTRAINT chk_payslip_publications_subject
  CHECK (user_id IS NOT NULL OR worker_id IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE payroll_bank_batch_items
  ADD CONSTRAINT chk_payroll_bank_batch_items_subject
  CHECK (user_id IS NOT NULL OR worker_id IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE payroll_tds_ytd_ledger
  ADD CONSTRAINT chk_payroll_tds_ytd_ledger_subject
  CHECK (user_id IS NOT NULL OR worker_id IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE payslip_publications
  ADD CONSTRAINT fk_payslip_publications_org_worker
  FOREIGN KEY (org_id, worker_id)
  REFERENCES workers (organization_id, worker_id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint

ALTER TABLE payroll_bank_batch_items
  ADD CONSTRAINT fk_payroll_bank_batch_items_org_worker
  FOREIGN KEY (org_id, worker_id)
  REFERENCES workers (organization_id, worker_id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint

ALTER TABLE payroll_tds_ytd_ledger
  ADD CONSTRAINT fk_payroll_tds_ytd_ledger_org_worker
  FOREIGN KEY (org_id, worker_id)
  REFERENCES workers (organization_id, worker_id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint

DROP INDEX IF EXISTS uniq_payroll_tds_ytd_user_period;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_payroll_tds_ytd_user_period
  ON payroll_tds_ytd_ledger (org_id, user_id, fiscal_year, period_key)
  WHERE user_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_payroll_tds_ytd_worker_period
  ON payroll_tds_ytd_ledger (org_id, worker_id, fiscal_year, period_key)
  WHERE worker_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_payslip_publications_org_worker
  ON payslip_publications (org_id, worker_id)
  WHERE worker_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_payroll_bank_batch_items_org_worker
  ON payroll_bank_batch_items (org_id, worker_id)
  WHERE worker_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_payroll_tds_ytd_worker_fy
  ON payroll_tds_ytd_ledger (org_id, worker_id, fiscal_year)
  WHERE worker_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE payslip_publications
  VALIDATE CONSTRAINT chk_payslip_publications_subject;
--> statement-breakpoint

ALTER TABLE payroll_bank_batch_items
  VALIDATE CONSTRAINT chk_payroll_bank_batch_items_subject;
--> statement-breakpoint

ALTER TABLE payroll_tds_ytd_ledger
  VALIDATE CONSTRAINT chk_payroll_tds_ytd_ledger_subject;
--> statement-breakpoint

ALTER TABLE payslip_publications
  VALIDATE CONSTRAINT fk_payslip_publications_org_worker;
--> statement-breakpoint

ALTER TABLE payroll_bank_batch_items
  VALIDATE CONSTRAINT fk_payroll_bank_batch_items_org_worker;
--> statement-breakpoint

ALTER TABLE payroll_tds_ytd_ledger
  VALIDATE CONSTRAINT fk_payroll_tds_ytd_ledger_org_worker;
