-- Migration 0243: Finance banking and reconciliation

DO $$ BEGIN
  CREATE TYPE fin_bank_account_type AS ENUM ('BANK', 'CASH', 'CARD', 'WALLET');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fin_bank_import_format AS ENUM ('CSV', 'OFX', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fin_bank_import_status AS ENUM ('PENDING', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fin_bank_txn_status AS ENUM ('UNMATCHED', 'SUGGESTED', 'MATCHED', 'RECONCILED', 'IGNORED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fin_recon_match_type AS ENUM (
    'CUSTOMER_PAYMENT', 'VENDOR_PAYMENT', 'EXPENSE_REIMBURSEMENT',
    'PAYROLL', 'BANK_FEE', 'TRANSFER', 'MANUAL_JOURNAL'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS fin_bank_accounts (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  account_type fin_bank_account_type NOT NULL DEFAULT 'BANK',
  account_number_masked text,
  bank_name text,
  ifsc text,
  currency text NOT NULL DEFAULT 'INR',
  ledger_account_id integer REFERENCES ledger_accounts(id),
  opening_balance decimal(18,4) NOT NULL DEFAULT 0,
  current_balance decimal(18,4) NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_fin_bank_accounts_org_name UNIQUE (org_id, name)
);
CREATE INDEX IF NOT EXISTS idx_fin_bank_accounts_org_active ON fin_bank_accounts (org_id, is_active);

CREATE TABLE IF NOT EXISTS fin_bank_imports (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bank_account_id integer NOT NULL REFERENCES fin_bank_accounts(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  format fin_bank_import_format NOT NULL,
  row_count integer NOT NULL DEFAULT 0,
  imported_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  status fin_bank_import_status NOT NULL DEFAULT 'PENDING',
  column_mapping jsonb,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_bank_imports_org_account ON fin_bank_imports (org_id, bank_account_id);

CREATE TABLE IF NOT EXISTS fin_bank_transactions (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bank_account_id integer NOT NULL REFERENCES fin_bank_accounts(id) ON DELETE CASCADE,
  import_id integer REFERENCES fin_bank_imports(id) ON DELETE SET NULL,
  txn_date date NOT NULL,
  description text,
  reference text,
  amount decimal(18,4) NOT NULL,
  balance_after decimal(18,4),
  counterparty text,
  fingerprint text NOT NULL,
  status fin_bank_txn_status NOT NULL DEFAULT 'UNMATCHED',
  matched_journal_entry_id integer REFERENCES journal_entries(id),
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_fin_bank_txn_org_account_fp UNIQUE (org_id, bank_account_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_fin_bank_txn_org_account_status ON fin_bank_transactions (org_id, bank_account_id, status);
CREATE INDEX IF NOT EXISTS idx_fin_bank_txn_org_date ON fin_bank_transactions (org_id, txn_date);

CREATE TABLE IF NOT EXISTS fin_reconciliation_matches (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bank_transaction_id integer NOT NULL REFERENCES fin_bank_transactions(id) ON DELETE CASCADE,
  journal_entry_id integer REFERENCES journal_entries(id),
  matched_type fin_recon_match_type NOT NULL,
  matched_record_id integer,
  amount decimal(18,4) NOT NULL,
  confidence decimal(5,2),
  is_confirmed boolean NOT NULL DEFAULT false,
  confirmed_by text REFERENCES users(id),
  confirmed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_recon_matches_org_txn ON fin_reconciliation_matches (org_id, bank_transaction_id);
CREATE INDEX IF NOT EXISTS idx_fin_recon_matches_org_je ON fin_reconciliation_matches (org_id, journal_entry_id);

CREATE TABLE IF NOT EXISTS fin_reconciliation_rules (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  conditions jsonb NOT NULL,
  action jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_reconciliation_rules_org_priority ON fin_reconciliation_rules (org_id, priority);

CREATE TABLE IF NOT EXISTS fin_bank_transfers (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  from_bank_account_id integer NOT NULL REFERENCES fin_bank_accounts(id),
  to_bank_account_id integer NOT NULL REFERENCES fin_bank_accounts(id),
  amount decimal(18,4) NOT NULL,
  transfer_date date NOT NULL,
  reference text,
  journal_entry_id integer REFERENCES journal_entries(id),
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_bank_transfers_org_date ON fin_bank_transfers (org_id, transfer_date);
CREATE INDEX IF NOT EXISTS idx_fin_bank_transfers_from ON fin_bank_transfers (from_bank_account_id);
CREATE INDEX IF NOT EXISTS idx_fin_bank_transfers_to ON fin_bank_transfers (to_bank_account_id);
