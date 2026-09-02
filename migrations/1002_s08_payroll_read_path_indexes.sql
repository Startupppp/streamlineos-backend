-- Three payroll read paths ticket 24 found unindexed, plus the two narrower
-- indexes each of the first two strictly subsumes.
--
-- 1. payroll_run_employees. The run-items list filters (org_id, run_id, status)
--    and only (org_id, run_id) is indexed, so every status filter reads the whole
--    run partition and discards. The new index is a strict superset of
--    idx_payroll_run_employees_org_run in the same column order, so that index
--    can serve no read this one cannot and is dropped in the same statement set.
--
-- 2. payroll_runs. The entity-scoped run list orders by month within an entity;
--    idx_payroll_runs_org_entity supplies neither the month predicate nor the
--    order. Same strict-prefix relationship, same drop. id is the tiebreak that
--    makes the keyset page deterministic.
--
-- 3. payslip_publications. The employee-facing payslip list is
--    (org_id, user_id) + a status filter; the two existing indexes are
--    (org_id, status) and a bare (user_id), and neither leads with the pair.
--    Nothing is subsumed here, so nothing is dropped.
--
-- Plain CREATE INDEX, not CONCURRENTLY: check:migration-discipline rule 7 rejects
-- CONCURRENTLY because drizzle-kit migrate wraps each file in a transaction, and
-- lock_timeout above makes the build fail fast rather than queue.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_payroll_run_employees_org_run_status
  ON payroll_run_employees (org_id, run_id, status);
--> statement-breakpoint

DROP INDEX IF EXISTS idx_payroll_run_employees_org_run;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_payroll_runs_org_entity_month
  ON payroll_runs (org_id, entity_id, month, id);
--> statement-breakpoint

DROP INDEX IF EXISTS idx_payroll_runs_org_entity;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_payslip_publications_org_user_status
  ON payslip_publications (org_id, user_id, status);
--> statement-breakpoint

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(t.name, ', ') INTO missing
  FROM (VALUES
    ('idx_payroll_run_employees_org_run_status'),
    ('idx_payroll_runs_org_entity_month'),
    ('idx_payslip_publications_org_user_status')
  ) AS t(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_indexes i WHERE i.indexname = t.name);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'payroll read-path indexes missing: %', missing;
  END IF;
END $$;
