-- 1050 DOWN -- takes run_id back out of the TDS year-to-date ledger's natural
--             key and returns the column to nullable.
--
-- 1050 writes no rows. It flips run_id to NOT NULL (via the CHECK NOT VALID ->
-- VALIDATE -> SET NOT NULL -> DROP CHECK sequence, all four steps of which are
-- catalog-only) and it replaces two unique indexes with wider ones. Nothing is
-- backfilled, de-duplicated or deleted, so every object 1050 touches has an
-- inverse -- with one condition this file must CHECK rather than assume.
--
-- REFUSES RATHER THAN DELETES. Narrowing a unique key is not the symmetric twin
-- of widening one. Every ledger row written while 1050 was applied is keyed per
-- run, so a month that locked a REGULAR run and, say, an OFF_CYCLE run now holds
-- two rows for one (org_id, subject, fiscal_year, period_key) -- legitimately;
-- that is the entire point of 1050, and it is what makes a fiscal year's
-- withholding the SUM over its rows. The pre-1050 index cannot cover both.
-- Deciding which run's withholding survives is a tax decision: the losing row is
-- the record of rupees actually deducted from an employee and remitted on a
-- challan, and no migration may destroy that silently. The DO block below
-- therefore names the colliding tuples and aborts, exactly as 1049 and 1052
-- refuse on the way in. The narrow indexes are then created WITHOUT
-- "IF NOT EXISTS" so that even a tuple the sampling missed raises 23505 rather
-- than being skipped.
--
-- No row is UPDATEd or DELETEd here, so 1030's guard_paid_payroll_tds_ytd_row
-- (BEFORE DELETE OR UPDATE) is never engaged by this file. It stays in place, and
-- with the key narrowed it goes back to being the only thing standing between a
-- second run's upsert and the first run's ledger row -- which it only catches
-- once that first run has reached PAID / PAYSLIPS_PUBLISHED / CLOSED.
--
-- @reopens-a-defect: running this restores the cross-run overwrite 1050 exists to
-- end. writeTdsYtdLedger's ON CONFLICT DO UPDATE SET taxable_income_paise =
-- excluded... REPLACES rather than accumulates, so the second run locked in a
-- month again overwrites the first run's withholding and the employee's
-- year-to-date figure under-reports every rupee the earlier run took. Revert the
-- runId .notNull() and the two uniqueIndex declarations in
-- src/db/schema/payroll/entities-periods.ts in the same change, or the
-- declaration and the catalog disagree.
--
-- fk_payroll_tds_ytd_ledger_run_id_org (migration 1026) and
-- idx_payroll_tds_ytd_ledger_org_run are NOT touched: 1050 did not create them and
-- both remain valid against a nullable run_id -- the index is already partial on
-- run_id IS NOT NULL, and a composite foreign key with a NULL member is simply
-- not enforced.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  user_duplicate_count integer;
  user_sample text;
  worker_duplicate_count integer;
  worker_sample text;
BEGIN
  SELECT count(*), coalesce(string_agg(format('(%s, %s, %s, %s) x%s', d.org_id, d.user_id, d.fiscal_year, d.period_key, d.n), '; '), '')
    INTO user_duplicate_count, user_sample
    FROM (
      SELECT org_id, user_id, fiscal_year, period_key, count(*) AS n
        FROM payroll_tds_ytd_ledger
       WHERE user_id IS NOT NULL
       GROUP BY org_id, user_id, fiscal_year, period_key
      HAVING count(*) > 1
       LIMIT 20
    ) d;

  SELECT count(*), coalesce(string_agg(format('(%s, %s, %s, %s) x%s', d.org_id, d.worker_id, d.fiscal_year, d.period_key, d.n), '; '), '')
    INTO worker_duplicate_count, worker_sample
    FROM (
      SELECT org_id, worker_id, fiscal_year, period_key, count(*) AS n
        FROM payroll_tds_ytd_ledger
       WHERE worker_id IS NOT NULL
       GROUP BY org_id, worker_id, fiscal_year, period_key
      HAVING count(*) > 1
       LIMIT 20
    ) d;

  IF user_duplicate_count > 0 OR worker_duplicate_count > 0 THEN
    RAISE EXCEPTION
      'payroll_tds_ytd_ledger holds more than one run per subject and period: % user tuple(s), % worker tuple(s). uniq_payroll_tds_ytd_user_period / uniq_payroll_tds_ytd_worker_period cannot be narrowed back to (org_id, subject, fiscal_year, period_key) until they are resolved. First user tuples: %. First worker tuples: %',
      user_duplicate_count, worker_duplicate_count, user_sample, worker_sample
      USING HINT = 'Each of these rows is tax withheld by a different payroll run and remitted on a challan. Decide per tuple what the single pre-1050 row should say -- the sum of the runs, not one of them -- and reconcile it against the payslips and challans already issued before re-running this rollback. Do not delete blindly.';
  END IF;
END
$$;
--> statement-breakpoint

DROP INDEX IF EXISTS uniq_payroll_tds_ytd_worker_period;
--> statement-breakpoint

CREATE UNIQUE INDEX uniq_payroll_tds_ytd_worker_period
  ON payroll_tds_ytd_ledger (org_id, worker_id, fiscal_year, period_key)
  WHERE worker_id IS NOT NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS uniq_payroll_tds_ytd_user_period;
--> statement-breakpoint

CREATE UNIQUE INDEX uniq_payroll_tds_ytd_user_period
  ON payroll_tds_ytd_ledger (org_id, user_id, fiscal_year, period_key)
  WHERE user_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE payroll_tds_ytd_ledger ALTER COLUMN run_id DROP NOT NULL;
