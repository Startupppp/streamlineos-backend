-- Migration 0244: Finance tax codes and tax payments

DO $$ BEGIN
  CREATE TYPE acc_tax_type AS ENUM ('GST', 'CGST_SGST', 'IGST', 'VAT', 'TDS', 'TCS', 'EXEMPT', 'ZERO_RATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS acc_tax_codes (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text NOT NULL,
  rate decimal(5,2) NOT NULL,
  tax_type acc_tax_type NOT NULL,
  is_reverse_charge boolean NOT NULL DEFAULT false,
  collected_account_id integer REFERENCES ledger_accounts(id),
  paid_account_id integer REFERENCES ledger_accounts(id),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_acc_tax_codes_org_code UNIQUE (org_id, code)
);
CREATE INDEX IF NOT EXISTS idx_acc_tax_codes_org_type ON acc_tax_codes (org_id, tax_type);

CREATE TABLE IF NOT EXISTS acc_tax_payments (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tax_type acc_tax_type NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  amount decimal(18,4) NOT NULL,
  paid_date date,
  reference text,
  journal_entry_id integer REFERENCES journal_entries(id),
  notes text,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_acc_tax_payments_org_type ON acc_tax_payments (org_id, tax_type);
CREATE INDEX IF NOT EXISTS idx_acc_tax_payments_org_period ON acc_tax_payments (org_id, period_start, period_end);
