-- PayrollOS FR-ACC-001: versioned accounting journal outbox with reversal + reconciliation.
-- Additive and reversible: creates two new tables and two enums, touches nothing existing.

DO $$
BEGIN
  CREATE TYPE payroll_journal_batch_status AS ENUM (
    'DRAFT', 'POSTED', 'EXPORTED', 'REVERSED', 'FAILED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE payroll_journal_recon_status AS ENUM (
    'UNRECONCILED', 'RECONCILED', 'DISPUTED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS payroll_journal_batches (
  id                    serial PRIMARY KEY,
  org_id                text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_id             integer REFERENCES payroll_entities(id) ON DELETE SET NULL,
  run_id                integer REFERENCES payroll_runs(id) ON DELETE SET NULL,
  period_key            text NOT NULL,
  version               integer NOT NULL DEFAULT 1,
  status                payroll_journal_batch_status NOT NULL DEFAULT 'DRAFT',
  reconciliation_status payroll_journal_recon_status NOT NULL DEFAULT 'UNRECONCILED',
  reversal_of_batch_id  integer REFERENCES payroll_journal_batches(id) ON DELETE SET NULL,
  reversal_reason       text,
  provisional           boolean NOT NULL DEFAULT false,
  source_hash           text NOT NULL,
  total_debits          numeric(15, 2) NOT NULL,
  total_credits         numeric(15, 2) NOT NULL,
  line_count            integer NOT NULL DEFAULT 0,
  unmapped_codes        jsonb,
  note                  text,
  reconciliation_note   text,
  posted_at             timestamp,
  posted_by             text REFERENCES users(id) ON DELETE SET NULL,
  exported_at           timestamp,
  exported_by           text REFERENCES users(id) ON DELETE SET NULL,
  reversed_at           timestamp,
  reversed_by           text REFERENCES users(id) ON DELETE SET NULL,
  reconciled_at         timestamp,
  reconciled_by         text REFERENCES users(id) ON DELETE SET NULL,
  created_by            text REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamp NOT NULL DEFAULT now(),
  updated_at            timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_payroll_journal_batches_org_period_version
  ON payroll_journal_batches (org_id, period_key, version);
CREATE INDEX IF NOT EXISTS idx_payroll_journal_batches_org_status
  ON payroll_journal_batches (org_id, status);
CREATE INDEX IF NOT EXISTS idx_payroll_journal_batches_org_run
  ON payroll_journal_batches (org_id, run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_journal_batches_org_recon
  ON payroll_journal_batches (org_id, reconciliation_status);
CREATE INDEX IF NOT EXISTS idx_payroll_journal_batches_source_hash
  ON payroll_journal_batches (org_id, source_hash);

CREATE TABLE IF NOT EXISTS payroll_journal_batch_lines (
  id          serial PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  batch_id    integer NOT NULL REFERENCES payroll_journal_batches(id) ON DELETE CASCADE,
  line_no     integer NOT NULL,
  account     text NOT NULL,
  description text NOT NULL,
  debit       numeric(15, 2) NOT NULL DEFAULT 0,
  credit      numeric(15, 2) NOT NULL DEFAULT 0,
  cost_center text,
  created_at  timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_payroll_journal_batch_lines_batch_line
  ON payroll_journal_batch_lines (batch_id, line_no);
CREATE INDEX IF NOT EXISTS idx_payroll_journal_batch_lines_org_batch
  ON payroll_journal_batch_lines (org_id, batch_id);
