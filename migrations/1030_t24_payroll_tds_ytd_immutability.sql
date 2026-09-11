-- The sixth and last payroll financial table without a data-layer immutability
-- guard. 0445 covered payroll_run_employees and payroll_line_items; 1001 covered
-- payroll_journal_batches, payroll_journal_batch_lines, payroll_bank_batches,
-- payroll_bank_batch_items and payroll_filings, and deliberately left
-- payroll_tds_ytd_ledger open as a payroll question rather than a schema one.
-- This answers it. Shape is 0445's and 1001's, not a new one: one BEFORE UPDATE
-- OR DELETE row trigger, an explicit list of the columns carrying financial
-- substance, and a parent-row escape hatch for every cascading delete. It reuses
-- 1001's payroll_org_still_present() rather than introducing a second mechanism.
--
-- The frozen predicate is the run recorded on the row having been PAID OUT --
-- status PAID, PAYSLIPS_PUBLISHED or CLOSED. That is narrower than 0445's
-- payroll_run_is_locked(), and the state machine is what makes it the right one.
--
-- 1001 rejected both obvious predicates for this table. Its first objection was
-- that payroll_run_is_locked() breaks run locking, because locking.service.ts
-- sets payroll_runs.status = 'LOCKED' at :145 and then upserts the ledger at
-- :244 / :308 in the SAME transaction, so the run is already locked when the
-- ON CONFLICT DO UPDATE branch fires on a re-lock. That objection is correct and
-- this predicate answers it directly: PAYROLL_RUN_TRANSITIONS
-- (payroll.types.ts:303) admits REOPENED only from LOCKED --
--
--     LOCKED -> [PAID, REOPENED]   PAID -> [PAYSLIPS_PUBLISHED]
--     PAYSLIPS_PUBLISHED -> [CLOSED]   CLOSED -> []   REOPENED -> [DRAFT]
--
-- so a run that has reached PAID can never return to a lockable state and can
-- never re-enter writeTdsYtdLedger. Every legitimate re-lock therefore sees its
-- own run in status LOCKED, which is not in the frozen set, and passes.
--
-- 1001's second objection was that PAID/PUBLISHED/CLOSED then blocks an
-- adjustment run writing the same (org, subject, fiscal_year, period_key) key
-- after the regular run is paid. That is the write this guard is FOR, and it is
-- destructive today rather than merely surprising. uniq_payroll_runs_org_month_type_entity
-- allows a BONUS / OFF_CYCLE / CORRECTION / FINAL_SETTLEMENT run in the same
-- month as the REGULAR one, writeTdsYtdLedger keys the ledger on payroll_runs.month
-- alone, and its ON CONFLICT DO UPDATE REPLACES taxable_income_paise and
-- tds_paise rather than accumulating them. So locking a second run for a month
-- whose regular run is already paid silently overwrites the tax actually withheld
-- from the employee -- the number printed on their payslip and reported on the
-- challan -- with the adjustment run's figure alone. Refusing that is the correct
-- outcome for a financial record; making off-cycle runs accumulate correctly
-- needs run_id in the ledger's natural key, which is a schema declaration change
-- and is reported to ticket 24 as a follow-up rather than smuggled in here.
--
-- Escape hatches, one per inbound cascading action. Unlike 1001's five tables
-- this one is reached by NO ON DELETE SET NULL foreign key, so no column has to
-- be excluded to keep SET NULL working -- checked in pg_constraint, not assumed:
--   org_id            -> organizations ON DELETE CASCADE      (0292)
--   user_id           -> users         ON DELETE CASCADE      (0292, nullable since 0393)
--   (org_id, worker_id) -> workers     ON DELETE RESTRICT     (0393)
--   run_id            -> no foreign key at all
-- An organisation purge (cron-org-purge-worker.service.ts:241) and a user purge
-- both reach this table while the run is still present, so the DELETE guard
-- stands aside once its organisation or its user has already gone. run_id
-- carrying no FK is why nothing here needs 1001's SET NULL exclusions -- and it
-- also means a deleted run leaves the row unfrozen, the same escape 0445 takes.
--
-- Excluded from the guarded column list: nothing. Every column this table has is
-- either the taxpayer's identity, the tax period, or money. The one writer
-- (locking.service.ts writeTdsYtdLedger) touches run_id, taxable_income_paise,
-- tds_paise and worker_id on the conflict branch and nothing else, and it can
-- only reach a frozen row through the cross-run overwrite above.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION payroll_run_is_paid_out(p_run_id integer) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM payroll_runs
    WHERE id = p_run_id
      AND status IN ('PAID', 'PAYSLIPS_PUBLISHED', 'CLOSED')
  );
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_paid_payroll_tds_ytd_row() RETURNS trigger AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF payroll_run_is_paid_out(OLD.run_id)
       AND payroll_org_still_present(OLD.org_id)
       AND (OLD.user_id IS NULL OR EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id))
    THEN
      RAISE EXCEPTION
        'payroll_tds_ytd_ledger row % records tax withheld by paid run % and cannot be deleted',
        OLD.id, OLD.run_id
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF payroll_run_is_paid_out(OLD.run_id)
     AND (
       NEW.org_id      IS DISTINCT FROM OLD.org_id
       OR NEW.user_id   IS DISTINCT FROM OLD.user_id
       OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
       OR NEW.fiscal_year IS DISTINCT FROM OLD.fiscal_year
       OR NEW.period_key  IS DISTINCT FROM OLD.period_key
       OR NEW.run_id      IS DISTINCT FROM OLD.run_id
       OR NEW.taxable_income_paise IS DISTINCT FROM OLD.taxable_income_paise
       OR NEW.tds_paise            IS DISTINCT FROM OLD.tds_paise
       OR NEW.previous_employer_income_paise IS DISTINCT FROM OLD.previous_employer_income_paise
       OR NEW.previous_employer_tds_paise    IS DISTINCT FROM OLD.previous_employer_tds_paise
       OR NEW.perquisites_paise IS DISTINCT FROM OLD.perquisites_paise
       OR NEW.surcharge_paise   IS DISTINCT FROM OLD.surcharge_paise
       OR NEW.rebate_paise      IS DISTINCT FROM OLD.rebate_paise
       OR NEW.created_at        IS DISTINCT FROM OLD.created_at
     )
  THEN
    RAISE EXCEPTION
      'payroll_tds_ytd_ledger row % records tax withheld by paid run % and cannot be rewritten',
      OLD.id, OLD.run_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$guard$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_paid_payroll_tds_ytd_row ON payroll_tds_ytd_ledger;
--> statement-breakpoint

CREATE TRIGGER trg_guard_paid_payroll_tds_ytd_row
  BEFORE UPDATE OR DELETE ON payroll_tds_ytd_ledger
  FOR EACH ROW EXECUTE FUNCTION guard_paid_payroll_tds_ytd_row();
--> statement-breakpoint

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(t.name, ', ') INTO missing
  FROM (VALUES
    ('trg_guard_locked_payroll_run_employee'),
    ('trg_guard_locked_payroll_line_item'),
    ('trg_guard_posted_payroll_journal_batch'),
    ('trg_guard_posted_payroll_journal_batch_line'),
    ('trg_guard_released_payroll_bank_batch'),
    ('trg_guard_released_payroll_bank_batch_item'),
    ('trg_guard_submitted_payroll_filing'),
    ('trg_guard_paid_payroll_tds_ytd_row')
  ) AS t(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger g WHERE g.tgname = t.name AND NOT g.tgisinternal
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'payroll immutability triggers missing: %', missing;
  END IF;
END $$;
