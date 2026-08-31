SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_payroll_bank_batches_org_generated_at
  ON payroll_bank_batches (org_id, generated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_roles_org_module_name_id
  ON roles (org_id, module_key, name, id);
