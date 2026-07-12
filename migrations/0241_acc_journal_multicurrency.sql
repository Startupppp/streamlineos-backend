-- Migration 0241: Journal multicurrency, ledger account extensions, enum extensions
ALTER TYPE acc_normal_balance ADD VALUE IF NOT EXISTS 'DEBIT';
ALTER TYPE acc_normal_balance ADD VALUE IF NOT EXISTS 'CREDIT';

ALTER TYPE journal_entry_status ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL';

ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'SENT';
ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'PARTIALLY_PAID';
ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'OVERDUE';

ALTER TABLE ledger_accounts
  ADD COLUMN IF NOT EXISTS normal_balance acc_normal_balance,
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS posting_date date,
  ADD COLUMN IF NOT EXISTS period_id integer REFERENCES accounting_periods(id),
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS approved_by text REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at timestamp,
  ADD COLUMN IF NOT EXISTS posted_by text REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS posted_at timestamp,
  ADD COLUMN IF NOT EXISTS reversed_entry_id integer REFERENCES journal_entries(id) ON DELETE SET NULL;

ALTER TABLE journal_lines
  ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS exchange_rate decimal(18,8),
  ADD COLUMN IF NOT EXISTS base_debit decimal(18,4),
  ADD COLUMN IF NOT EXISTS base_credit decimal(18,4),
  ADD COLUMN IF NOT EXISTS client_id integer,
  ADD COLUMN IF NOT EXISTS vendor_id integer,
  ADD COLUMN IF NOT EXISTS project_id integer,
  ADD COLUMN IF NOT EXISTS department_id integer,
  ADD COLUMN IF NOT EXISTS employee_id integer,
  ADD COLUMN IF NOT EXISTS tax_code_id integer,
  ADD COLUMN IF NOT EXISTS dimension_values jsonb;

UPDATE journal_lines jl
  SET org_id = je.org_id
  FROM journal_entries je
  WHERE jl.entry_id = je.id AND jl.org_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_jl_org_account ON journal_lines (org_id, account_id);

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS amount_paid decimal(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exchange_rate decimal(18,8) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS collection_owner_id text REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS promise_to_pay_date date,
  ADD COLUMN IF NOT EXISTS next_reminder_at timestamp,
  ADD COLUMN IF NOT EXISTS recurring_template_id integer;

CREATE INDEX IF NOT EXISTS idx_invoices_collection_owner ON invoices (collection_owner_id);

ALTER TABLE purchase_bills
  ADD COLUMN IF NOT EXISTS exchange_rate decimal(18,8) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS approved_by text REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at timestamp,
  ADD COLUMN IF NOT EXISTS recurring_template_id integer;

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS receipt_number text,
  ADD COLUMN IF NOT EXISTS receipt_hash text,
  ADD COLUMN IF NOT EXISTS tax_amount decimal(12,2),
  ADD COLUMN IF NOT EXISTS posted_journal_entry_id integer REFERENCES journal_entries(id),
  ADD COLUMN IF NOT EXISTS policy_flag text;

CREATE INDEX IF NOT EXISTS idx_expenses_org_receipt_hash ON expenses (org_id, receipt_hash);
