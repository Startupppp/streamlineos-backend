SET lock_timeout = '5s';

-- payroll_runs: add companion columns for all remaining legacy actor columns
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS locked_by_membership_id integer;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS paid_by_membership_id integer;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS published_by_membership_id integer;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS closed_by_membership_id integer;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS reopened_by_membership_id integer;
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS created_by_membership_id integer;

-- payroll_runs: backfill locked_by_membership_id
DO $$ BEGIN
  UPDATE payroll_runs t
  SET locked_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.locked_by
    AND t.locked_by_membership_id IS NULL;
END $$;

-- payroll_runs: backfill paid_by_membership_id
DO $$ BEGIN
  UPDATE payroll_runs t
  SET paid_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.paid_by
    AND t.paid_by_membership_id IS NULL;
END $$;

-- payroll_runs: backfill published_by_membership_id
DO $$ BEGIN
  UPDATE payroll_runs t
  SET published_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.published_by
    AND t.published_by_membership_id IS NULL;
END $$;

-- payroll_runs: backfill closed_by_membership_id
DO $$ BEGIN
  UPDATE payroll_runs t
  SET closed_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.closed_by
    AND t.closed_by_membership_id IS NULL;
END $$;

-- payroll_runs: backfill reopened_by_membership_id
DO $$ BEGIN
  UPDATE payroll_runs t
  SET reopened_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.reopened_by
    AND t.reopened_by_membership_id IS NULL;
END $$;

-- payroll_runs: backfill created_by_membership_id
DO $$ BEGIN
  UPDATE payroll_runs t
  SET created_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.created_by
    AND t.created_by_membership_id IS NULL;
END $$;

-- payroll_runs: add FK constraints (NOT VALID) and validate
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_runs_locked_actor') THEN
    ALTER TABLE payroll_runs ADD CONSTRAINT fk_payroll_runs_locked_actor
      FOREIGN KEY (org_id, locked_by_membership_id)
      REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
ALTER TABLE payroll_runs VALIDATE CONSTRAINT fk_payroll_runs_locked_actor;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_runs_paid_actor') THEN
    ALTER TABLE payroll_runs ADD CONSTRAINT fk_payroll_runs_paid_actor
      FOREIGN KEY (org_id, paid_by_membership_id)
      REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
ALTER TABLE payroll_runs VALIDATE CONSTRAINT fk_payroll_runs_paid_actor;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_runs_published_actor') THEN
    ALTER TABLE payroll_runs ADD CONSTRAINT fk_payroll_runs_published_actor
      FOREIGN KEY (org_id, published_by_membership_id)
      REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
ALTER TABLE payroll_runs VALIDATE CONSTRAINT fk_payroll_runs_published_actor;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_runs_closed_actor') THEN
    ALTER TABLE payroll_runs ADD CONSTRAINT fk_payroll_runs_closed_actor
      FOREIGN KEY (org_id, closed_by_membership_id)
      REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
ALTER TABLE payroll_runs VALIDATE CONSTRAINT fk_payroll_runs_closed_actor;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_runs_reopened_actor') THEN
    ALTER TABLE payroll_runs ADD CONSTRAINT fk_payroll_runs_reopened_actor
      FOREIGN KEY (org_id, reopened_by_membership_id)
      REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
ALTER TABLE payroll_runs VALIDATE CONSTRAINT fk_payroll_runs_reopened_actor;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_runs_created_actor') THEN
    ALTER TABLE payroll_runs ADD CONSTRAINT fk_payroll_runs_created_actor
      FOREIGN KEY (org_id, created_by_membership_id)
      REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
ALTER TABLE payroll_runs VALIDATE CONSTRAINT fk_payroll_runs_created_actor;

-- payroll_runs: indexes for new companion columns
CREATE INDEX IF NOT EXISTS idx_payroll_runs_org_locked_actor ON payroll_runs (org_id, locked_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_org_paid_actor ON payroll_runs (org_id, paid_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_org_published_actor ON payroll_runs (org_id, published_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_org_closed_actor ON payroll_runs (org_id, closed_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_org_reopened_actor ON payroll_runs (org_id, reopened_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_org_created_actor ON payroll_runs (org_id, created_by_membership_id);

-- payroll_journal_batches: add companion columns for all legacy actor columns
ALTER TABLE payroll_journal_batches ADD COLUMN IF NOT EXISTS posted_by_membership_id integer;
ALTER TABLE payroll_journal_batches ADD COLUMN IF NOT EXISTS exported_by_membership_id integer;
ALTER TABLE payroll_journal_batches ADD COLUMN IF NOT EXISTS reversed_by_membership_id integer;
ALTER TABLE payroll_journal_batches ADD COLUMN IF NOT EXISTS reconciled_by_membership_id integer;
ALTER TABLE payroll_journal_batches ADD COLUMN IF NOT EXISTS created_by_membership_id integer;

-- payroll_journal_batches: backfill posted_by_membership_id
DO $$ BEGIN
  UPDATE payroll_journal_batches t
  SET posted_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.posted_by
    AND t.posted_by_membership_id IS NULL;
END $$;

-- payroll_journal_batches: backfill exported_by_membership_id
DO $$ BEGIN
  UPDATE payroll_journal_batches t
  SET exported_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.exported_by
    AND t.exported_by_membership_id IS NULL;
END $$;

-- payroll_journal_batches: backfill reversed_by_membership_id
DO $$ BEGIN
  UPDATE payroll_journal_batches t
  SET reversed_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.reversed_by
    AND t.reversed_by_membership_id IS NULL;
END $$;

-- payroll_journal_batches: backfill reconciled_by_membership_id
DO $$ BEGIN
  UPDATE payroll_journal_batches t
  SET reconciled_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.reconciled_by
    AND t.reconciled_by_membership_id IS NULL;
END $$;

-- payroll_journal_batches: backfill created_by_membership_id
DO $$ BEGIN
  UPDATE payroll_journal_batches t
  SET created_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.created_by
    AND t.created_by_membership_id IS NULL;
END $$;

-- payroll_journal_batches: add FK constraints (NOT VALID) and validate
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_jrnl_batches_posted_actor') THEN
    ALTER TABLE payroll_journal_batches ADD CONSTRAINT fk_payroll_jrnl_batches_posted_actor
      FOREIGN KEY (org_id, posted_by_membership_id)
      REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
ALTER TABLE payroll_journal_batches VALIDATE CONSTRAINT fk_payroll_jrnl_batches_posted_actor;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_jrnl_batches_exported_actor') THEN
    ALTER TABLE payroll_journal_batches ADD CONSTRAINT fk_payroll_jrnl_batches_exported_actor
      FOREIGN KEY (org_id, exported_by_membership_id)
      REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
ALTER TABLE payroll_journal_batches VALIDATE CONSTRAINT fk_payroll_jrnl_batches_exported_actor;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_jrnl_batches_reversed_actor') THEN
    ALTER TABLE payroll_journal_batches ADD CONSTRAINT fk_payroll_jrnl_batches_reversed_actor
      FOREIGN KEY (org_id, reversed_by_membership_id)
      REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
ALTER TABLE payroll_journal_batches VALIDATE CONSTRAINT fk_payroll_jrnl_batches_reversed_actor;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_jrnl_batches_reconciled_actor') THEN
    ALTER TABLE payroll_journal_batches ADD CONSTRAINT fk_payroll_jrnl_batches_reconciled_actor
      FOREIGN KEY (org_id, reconciled_by_membership_id)
      REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
ALTER TABLE payroll_journal_batches VALIDATE CONSTRAINT fk_payroll_jrnl_batches_reconciled_actor;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_jrnl_batches_created_actor') THEN
    ALTER TABLE payroll_journal_batches ADD CONSTRAINT fk_payroll_jrnl_batches_created_actor
      FOREIGN KEY (org_id, created_by_membership_id)
      REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
ALTER TABLE payroll_journal_batches VALIDATE CONSTRAINT fk_payroll_jrnl_batches_created_actor;

-- payroll_journal_batches: indexes for new companion columns
CREATE INDEX IF NOT EXISTS idx_payroll_jrnl_batches_org_posted_actor ON payroll_journal_batches (org_id, posted_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_payroll_jrnl_batches_org_exported_actor ON payroll_journal_batches (org_id, exported_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_payroll_jrnl_batches_org_reversed_actor ON payroll_journal_batches (org_id, reversed_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_payroll_jrnl_batches_org_reconciled_actor ON payroll_journal_batches (org_id, reconciled_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_payroll_jrnl_batches_org_created_actor ON payroll_journal_batches (org_id, created_by_membership_id);
