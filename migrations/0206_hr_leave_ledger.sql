-- Migration 0206: hr_leave_ledger table + leaveTypes.category column
-- Idempotent: all CREATE ... IF NOT EXISTS / DO NOTHING patterns

DO $$ BEGIN
  CREATE TYPE hr_leave_txn_type AS ENUM (
    'accrual', 'consumption', 'carry_forward', 'encashment',
    'expiry', 'adjustment', 'comp_off_earn', 'comp_off_use', 'reversal'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_leave_ledger_source AS ENUM (
    'policy_accrual', 'request', 'cron', 'manual', 'import'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_leave_payroll_status AS ENUM (
    'pending', 'exported', 'locked'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS hr_leave_ledger (
  id              SERIAL PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id   INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE RESTRICT,
  txn_type        hr_leave_txn_type NOT NULL,
  days            NUMERIC(8,2) NOT NULL,
  effective_date  DATE NOT NULL,
  period          TEXT,
  source          hr_leave_ledger_source NOT NULL,
  source_id       TEXT,
  note            TEXT,
  payroll_status  hr_leave_payroll_status NOT NULL DEFAULT 'pending',
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_leave_ledger_user_type_date
  ON hr_leave_ledger (org_id, user_id, leave_type_id, effective_date DESC);

CREATE INDEX IF NOT EXISTS idx_hr_leave_ledger_payroll_status
  ON hr_leave_ledger (org_id, payroll_status);

CREATE INDEX IF NOT EXISTS idx_hr_leave_ledger_org_user
  ON hr_leave_ledger (org_id, user_id);

-- Backfill: derive opening-balance adjustment rows from existing leaveBalances
-- so existing balances are preserved in the ledger view. One row per balance record.
INSERT INTO hr_leave_ledger (
  org_id, user_id, leave_type_id, txn_type, days, effective_date,
  period, source, source_id, note, payroll_status, created_at
)
SELECT
  lb.org_id,
  lb.user_id,
  lb.leave_type_id,
  'adjustment'::hr_leave_txn_type,
  lb.balance,
  (lb.year || '-01-01')::DATE,
  lb.year::TEXT,
  'manual'::hr_leave_ledger_source,
  'balance_migration_' || lb.id::TEXT,
  'Opening balance migrated from leave_balances',
  'locked'::hr_leave_payroll_status,
  NOW()
FROM leave_balances lb
WHERE lb.balance > 0
ON CONFLICT DO NOTHING;
