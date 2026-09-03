SET lock_timeout = '5s';
--> statement-breakpoint

-- The year-to-date TDS ledger keyed on (org_id, subject, fiscal_year, period_key)
-- with no run_id, and locking.service.ts writeTdsYtdLedger upserts it with
-- ON CONFLICT DO UPDATE SET taxable_income_paise = excluded..., tds_paise = ...
-- That REPLACES rather than accumulates, and period_key is payroll_runs.month.
--
-- uniq_payroll_runs_org_month_type_entity deliberately allows a BONUS, OFF_CYCLE,
-- CORRECTION or FINAL_SETTLEMENT run in the same month as the REGULAR one. Locking
-- the second run therefore collided with the first run's ledger row for that month
-- and overwrote the tax actually withheld from the employee with the second run's
-- figure alone. The employee's year-to-date withholding then under-reported every
-- rupee the earlier run took -- the number printed on the payslip and reported on
-- the challan.
--
-- Migration 1030 recorded this exact defect and mitigated the narrow half of it:
-- guard_paid_payroll_tds_ytd_row raises 23514 when the overwrite would land on a
-- row whose run has already reached PAID / PAYSLIPS_PUBLISHED / CLOSED. It does
-- not fire while the first run is still merely LOCKED, which is the ordinary case
-- -- an off-cycle run for a month is normally locked alongside the regular one,
-- long before either is paid. 1030 named the real fix ("needs run_id in the
-- ledger's natural key, which is a schema declaration change") and deferred it.
-- This is that change.
--
-- With run_id in the key the ledger holds one row per (subject, fiscal year,
-- period, run), no upsert can ever reach another run's row, and a fiscal year's
-- withholding is the SUM over its rows -- which is what a year-to-date ledger
-- means. Widening a unique key can never fail on existing data, so no backfill
-- and no deduplication is involved.
--
-- run_id becomes NOT NULL in the same change: a nullable column in a unique key
-- is not a key, because two rows carrying NULL never conflict. The sole writer has
-- always set it. Split into CHECK NOT VALID -> VALIDATE -> SET NOT NULL -> DROP
-- CHECK so the ACCESS EXCLUSIVE lock is held only for the catalog flip.

ALTER TABLE payroll_tds_ytd_ledger
  ADD CONSTRAINT chk_payroll_tds_ytd_ledger_run_id_present
  CHECK (run_id IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE payroll_tds_ytd_ledger
  VALIDATE CONSTRAINT chk_payroll_tds_ytd_ledger_run_id_present;
--> statement-breakpoint

ALTER TABLE payroll_tds_ytd_ledger ALTER COLUMN run_id SET NOT NULL;
--> statement-breakpoint

ALTER TABLE payroll_tds_ytd_ledger
  DROP CONSTRAINT chk_payroll_tds_ytd_ledger_run_id_present;
--> statement-breakpoint

DROP INDEX IF EXISTS uniq_payroll_tds_ytd_user_period;
--> statement-breakpoint

CREATE UNIQUE INDEX uniq_payroll_tds_ytd_user_period
  ON payroll_tds_ytd_ledger (org_id, user_id, fiscal_year, period_key, run_id)
  WHERE user_id IS NOT NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS uniq_payroll_tds_ytd_worker_period;
--> statement-breakpoint

CREATE UNIQUE INDEX uniq_payroll_tds_ytd_worker_period
  ON payroll_tds_ytd_ledger (org_id, worker_id, fiscal_year, period_key, run_id)
  WHERE worker_id IS NOT NULL;
