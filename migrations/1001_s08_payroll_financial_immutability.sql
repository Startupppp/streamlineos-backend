-- Financial immutability at the data layer for six payroll tables that carry
-- money and had none. Migration 0445 put this guard on payroll_run_employees and
-- payroll_line_items; the posting, payout and filing legs were left with a
-- service-layer check only, and a service-layer check is bypassed by any direct
-- SQL, any script, and any future code path that forgets it. PRD 10.7 requires
-- payroll financial records be immutable where financial.
--
-- The escape hatch is wider than 0445's because these tables sit under more than
-- one cascading parent. A guard that reads only its own row's status blocks the
-- very deletes the schema is designed to perform: an organisation purge
-- (cron-org-purge-worker.service.ts:241 deletes the organisation row and lets
-- org_id ON DELETE CASCADE do the rest) reaches payroll_journal_batch_lines and
-- payroll_bank_batch_items directly while their batch is still present, and
-- deleting a payroll_runs row cascades into payroll_bank_batches while the
-- organisation is still present. Each guard therefore stands aside when ANY of its
-- cascading parents has already gone. This was not reasoned out -- the first draft
-- of this migration was rejected by exactly that delete on a scratch database.
--
-- Shape is 0445's, not a new one: a BEFORE UPDATE OR DELETE row trigger, an
-- explicit list of the columns that carry financial substance, and a parent-row
-- escape hatch so a cascading delete of the parent finds no row and is allowed
-- through. Everything not named is still writable, which is what keeps the
-- lifecycle working -- the columns each table's live code writes AFTER the record
-- reaches its financial state were read out of the services first and are
-- deliberately excluded:
--
--   payroll_journal_batches   markExported / reverseBatch / reconcile write
--                             status, exported_*, reversed_*, reversal_reason,
--                             reconciliation_*, reconciled_*, updated_at
--                             (journal-outbox.service.ts:290,395,431)
--   payroll_bank_batches      file_key lands in a post-commit hook AFTER the
--                             batch is already SENT (batch-creator.service.ts:313);
--                             status/sent_at drive the payout lifecycle
--   payroll_bank_batch_items  status, transaction_ref, paid_at, failure_reason
--                             are the paid/failed transitions
--                             (batch-status.service.ts:114,164,212)
--   payroll_filings           status, status_label, challan_ref,
--                             acknowledgement_ref, submitted_at
--                             (filings.service.ts:385)
--
-- Every column reachable by an ON DELETE SET NULL foreign key is excluded on
-- purpose. Postgres implements SET NULL as an UPDATE, so guarding entity_id,
-- run_id, reversal_of_batch_id, created_by, posted_by, the five *_by_membership_id
-- columns or payroll_filings.entity_id/period_id would make deleting an
-- organisation member, a user, an entity or a period fail against a posted batch.
--
-- payroll_tds_ytd_ledger is NOT included, and that is a finding rather than an
-- omission. The obvious guard -- payroll_run_is_locked(run_id), 0445's own helper --
-- would break run locking. locking.service.ts sets payroll_runs.status = 'LOCKED'
-- at :145 and then upserts the ledger at :244 and :308 in the SAME transaction, so
-- the run is already locked when the ON CONFLICT DO UPDATE branch fires on a
-- re-lock. Narrowing the predicate to PAID/PAYSLIPS_PUBLISHED/CLOSED avoids that
-- but then blocks an adjustment run writing the same (org, subject, fiscal_year,
-- period_key) key after the regular run is paid. Which of those two is correct is
-- a payroll decision, not a schema one; report 08 records it as open.

SET lock_timeout = '5s';
--> statement-breakpoint

-- An organisation purge (cron-org-purge-worker) hard-deletes the organisation row
-- and lets org_id ON DELETE CASCADE remove its children. By the time a child's
-- BEFORE DELETE fires the parent row is gone, so this returns false and the guard
-- stands aside -- the same escape hatch 0445 gets from reading payroll_runs.
CREATE OR REPLACE FUNCTION payroll_org_still_present(p_org_id text) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM organizations WHERE id = p_org_id);
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION payroll_journal_batch_is_final(p_batch_id integer) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM payroll_journal_batches
    WHERE id = p_batch_id AND status IN ('POSTED', 'EXPORTED', 'REVERSED')
  );
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION payroll_bank_batch_is_released(p_batch_id integer) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM payroll_bank_batches
    WHERE id = p_batch_id AND status IN ('SENT', 'PARTIALLY_PAID', 'PAID')
  );
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_posted_payroll_journal_batch() RETURNS trigger AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('POSTED', 'EXPORTED', 'REVERSED')
       AND payroll_org_still_present(OLD.org_id) THEN
      RAISE EXCEPTION
        'payroll_journal_batches row % is immutable in status %', OLD.id, OLD.status
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('POSTED', 'EXPORTED', 'REVERSED')
     AND (
       NEW.org_id         IS DISTINCT FROM OLD.org_id
       OR NEW.period_key   IS DISTINCT FROM OLD.period_key
       OR NEW.version      IS DISTINCT FROM OLD.version
       OR NEW.total_debits IS DISTINCT FROM OLD.total_debits
       OR NEW.total_credits IS DISTINCT FROM OLD.total_credits
       OR NEW.line_count   IS DISTINCT FROM OLD.line_count
       OR NEW.source_hash  IS DISTINCT FROM OLD.source_hash
       OR NEW.provisional  IS DISTINCT FROM OLD.provisional
       OR NEW.unmapped_codes IS DISTINCT FROM OLD.unmapped_codes
     )
  THEN
    RAISE EXCEPTION
      'payroll_journal_batches row % has posted amounts and cannot be rewritten', OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$guard$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_posted_payroll_journal_batch_line() RETURNS trigger AS $guard$
DECLARE target_batch integer;
BEGIN
  target_batch := COALESCE(NEW.batch_id, OLD.batch_id);
  IF payroll_journal_batch_is_final(target_batch)
     AND payroll_org_still_present(COALESCE(NEW.org_id, OLD.org_id)) THEN
    RAISE EXCEPTION
      'payroll_journal_batch_lines are immutable once batch % is posted', target_batch
      USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$guard$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_released_payroll_bank_batch() RETURNS trigger AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('SENT', 'PARTIALLY_PAID', 'PAID')
       AND payroll_org_still_present(OLD.org_id)
       AND EXISTS (SELECT 1 FROM payroll_runs WHERE id = OLD.run_id) THEN
      RAISE EXCEPTION
        'payroll_bank_batches row % is immutable in status %', OLD.id, OLD.status
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('SENT', 'PARTIALLY_PAID', 'PAID')
     AND (
       NEW.org_id       IS DISTINCT FROM OLD.org_id
       OR NEW.run_id     IS DISTINCT FROM OLD.run_id
       OR NEW.batch_number IS DISTINCT FROM OLD.batch_number
       OR NEW.format     IS DISTINCT FROM OLD.format
       OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
       OR NEW.item_count IS DISTINCT FROM OLD.item_count
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     )
  THEN
    RAISE EXCEPTION
      'payroll_bank_batches row % has been released to the bank and cannot be rewritten', OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$guard$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_released_payroll_bank_batch_item() RETURNS trigger AS $guard$
DECLARE target_batch integer;
BEGIN
  target_batch := COALESCE(NEW.batch_id, OLD.batch_id);

  IF TG_OP = 'DELETE' THEN
    IF payroll_bank_batch_is_released(target_batch)
       AND payroll_org_still_present(OLD.org_id)
       AND EXISTS (SELECT 1 FROM payroll_run_employees WHERE id = OLD.run_employee_id) THEN
      RAISE EXCEPTION
        'payroll_bank_batch_items row % cannot be deleted once batch % is released', OLD.id, target_batch
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF payroll_bank_batch_is_released(target_batch)
     AND (
       NEW.org_id     IS DISTINCT FROM OLD.org_id
       OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
       OR NEW.run_employee_id IS DISTINCT FROM OLD.run_employee_id
       OR NEW.user_id  IS DISTINCT FROM OLD.user_id
       OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
       OR NEW.amount   IS DISTINCT FROM OLD.amount
       OR NEW.account_masked IS DISTINCT FROM OLD.account_masked
       OR NEW.ifsc     IS DISTINCT FROM OLD.ifsc
     )
  THEN
    RAISE EXCEPTION
      'payroll_bank_batch_items row % carries a released payment instruction and cannot be rewritten', OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$guard$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_submitted_payroll_filing() RETURNS trigger AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.submitted_at IS NOT NULL AND payroll_org_still_present(OLD.org_id) THEN
      RAISE EXCEPTION
        'payroll_filings row % was submitted on % and cannot be deleted', OLD.id, OLD.submitted_at
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.submitted_at IS NOT NULL
     AND (
       NEW.org_id      IS DISTINCT FROM OLD.org_id
       OR NEW.fiscal_year IS DISTINCT FROM OLD.fiscal_year
       OR NEW.filing_type IS DISTINCT FROM OLD.filing_type
       OR NEW.rule_version IS DISTINCT FROM OLD.rule_version
       OR NEW.payload  IS DISTINCT FROM OLD.payload
       OR NEW.artifact_key IS DISTINCT FROM OLD.artifact_key
     )
  THEN
    RAISE EXCEPTION
      'payroll_filings row % was submitted and its return cannot be rewritten', OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$guard$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_posted_payroll_journal_batch ON payroll_journal_batches;
--> statement-breakpoint

CREATE TRIGGER trg_guard_posted_payroll_journal_batch
  BEFORE UPDATE OR DELETE ON payroll_journal_batches
  FOR EACH ROW EXECUTE FUNCTION guard_posted_payroll_journal_batch();
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_posted_payroll_journal_batch_line ON payroll_journal_batch_lines;
--> statement-breakpoint

CREATE TRIGGER trg_guard_posted_payroll_journal_batch_line
  BEFORE UPDATE OR DELETE ON payroll_journal_batch_lines
  FOR EACH ROW EXECUTE FUNCTION guard_posted_payroll_journal_batch_line();
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_released_payroll_bank_batch ON payroll_bank_batches;
--> statement-breakpoint

CREATE TRIGGER trg_guard_released_payroll_bank_batch
  BEFORE UPDATE OR DELETE ON payroll_bank_batches
  FOR EACH ROW EXECUTE FUNCTION guard_released_payroll_bank_batch();
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_released_payroll_bank_batch_item ON payroll_bank_batch_items;
--> statement-breakpoint

CREATE TRIGGER trg_guard_released_payroll_bank_batch_item
  BEFORE UPDATE OR DELETE ON payroll_bank_batch_items
  FOR EACH ROW EXECUTE FUNCTION guard_released_payroll_bank_batch_item();
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_submitted_payroll_filing ON payroll_filings;
--> statement-breakpoint

CREATE TRIGGER trg_guard_submitted_payroll_filing
  BEFORE UPDATE OR DELETE ON payroll_filings
  FOR EACH ROW EXECUTE FUNCTION guard_submitted_payroll_filing();
--> statement-breakpoint

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(t.name, ', ') INTO missing
  FROM (VALUES
    ('trg_guard_posted_payroll_journal_batch'),
    ('trg_guard_posted_payroll_journal_batch_line'),
    ('trg_guard_released_payroll_bank_batch'),
    ('trg_guard_released_payroll_bank_batch_item'),
    ('trg_guard_submitted_payroll_filing')
  ) AS t(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger g WHERE g.tgname = t.name AND NOT g.tgisinternal
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'payroll immutability triggers missing: %', missing;
  END IF;
END $$;
