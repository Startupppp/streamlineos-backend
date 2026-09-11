-- `payroll_tds_ytd_ledger.run_id` names the payroll run that withheld the tax and carries no
-- foreign key at all, so nothing stops a ledger row in one organisation from naming another
-- organisation's run, and nothing stops the run being deleted out from under the record of
-- the tax it withheld. Routed here by the coordinator; the table is declared in
-- `src/db/schema/payroll/entities-periods.ts`, which is this territory.
--
-- Child and parent are both tenant-owned, so the constraint is COMPOSITE
-- `(org_id, run_id) -> payroll_runs(org_id, id)`, matching the eleven sibling foreign keys
-- that already point at `payroll_runs`. `uniq_payroll_runs_org_id UNIQUE (org_id, id)` is
-- read from pg_constraint, not assumed.
--
-- NO ACTION, deliberately, and this is the load-bearing decision.
--
-- Migration 1030 put `guard_paid_payroll_tds_ytd_row` on this table as a BEFORE DELETE OR
-- UPDATE guard, and its UPDATE branch lists `run_id` among the columns that may not change
-- once `payroll_run_is_paid_out(run_id)`. `ON DELETE SET NULL` is implemented as an UPDATE,
-- so a SET NULL here would raise 23514 the moment anyone deleted a paid run -- the exact
-- defect class migration 1009 surfaced on `inv_stock_transactions.location_id`, introduced
-- rather than inherited. `ON DELETE CASCADE` hits the same guard's DELETE branch. NO ACTION
-- touches the child row at all, so it composes with the guard instead of fighting it, and it
-- states the right rule anyway: a run whose withheld tax is on the year-to-date ledger is not
-- deletable.
--
-- The organisation purge is unaffected and this was run, not reasoned about: NO ACTION is
-- checked at end of statement, and `DELETE FROM organizations` removes the ledger rows and
-- the runs in the same cascade, so no referencing row survives the check. The guard's own
-- `payroll_org_still_present(OLD.org_id)` clause is 1030 making the same allowance.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE payroll_tds_ytd_ledger
  ADD CONSTRAINT fk_payroll_tds_ytd_ledger_run_id_org
  FOREIGN KEY (org_id, run_id) REFERENCES payroll_runs (org_id, id) NOT VALID;
--> statement-breakpoint

ALTER TABLE payroll_tds_ytd_ledger VALIDATE CONSTRAINT fk_payroll_tds_ytd_ledger_run_id_org;
--> statement-breakpoint

-- Not CONCURRENTLY: db:migrate runs inside a transaction.
CREATE INDEX IF NOT EXISTS idx_payroll_tds_ytd_ledger_org_run
  ON payroll_tds_ytd_ledger (org_id, run_id) WHERE run_id IS NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_payroll_tds_ytd_ledger_run_id_org'
      AND contype = 'f' AND convalidated AND confdeltype = 'a')
  THEN
    RAISE EXCEPTION
      '1026: fk_payroll_tds_ytd_ledger_run_id_org is missing, unvalidated, or carries a referential action it must not have';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class i
    JOIN pg_index x ON x.indexrelid = i.oid
    WHERE i.relname = 'idx_payroll_tds_ytd_ledger_org_run'
      AND (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
             FROM unnest(x.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum) = 'org_id, run_id')
  THEN
    RAISE EXCEPTION
      '1026: idx_payroll_tds_ytd_ledger_org_run is missing or does not cover (org_id, run_id)';
  END IF;
END
$$;
