-- Migration 0247: Finance expense management — reimbursement batches, expense policies, expense extensions

DO $$ BEGIN
  CREATE TYPE fin_reimbursement_batch_status AS ENUM ('DRAFT', 'APPROVED', 'PAID');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS fin_reimbursement_batches (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  status fin_reimbursement_batch_status NOT NULL DEFAULT 'DRAFT',
  total_amount decimal(18,4) NOT NULL DEFAULT 0,
  paid_date date,
  journal_entry_id integer REFERENCES journal_entries(id),
  created_by text NOT NULL REFERENCES users(id),
  approved_by text REFERENCES users(id),
  approved_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_reimbursement_batches_org_status ON fin_reimbursement_batches (org_id, status);

CREATE TABLE IF NOT EXISTS fin_expense_policies (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  category_id integer REFERENCES expense_categories(id) ON DELETE SET NULL,
  max_amount decimal(12,2),
  requires_receipt_above decimal(12,2),
  requires_approval_above decimal(12,2),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_expense_policies_org ON fin_expense_policies (org_id);

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS reimbursement_batch_id integer REFERENCES fin_reimbursement_batches(id);

ALTER TYPE expense_status ADD VALUE IF NOT EXISTS 'DRAFT';
ALTER TYPE expense_status ADD VALUE IF NOT EXISTS 'SUBMITTED';
ALTER TYPE expense_status ADD VALUE IF NOT EXISTS 'REIMBURSEMENT_PENDING';
ALTER TYPE expense_status ADD VALUE IF NOT EXISTS 'REIMBURSED';
