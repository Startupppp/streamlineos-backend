-- BUG-001 data remediation: remove a payroll run that exists without a payroll policy.
--
-- Context. `RunsService.createRun` used to record a missing policy as
-- `policyVersionId = null` and insert the run anyway, and the controller
-- downgraded the resulting generation failure to a warning on a 201. The guard
-- that stops this is on `main` and is verified against a booted API: POST
-- /payroll/runs with no ACTIVE policy version answers 409 CONFLICT and
-- `payroll_runs` does not grow. The guard does not remove a row already written,
-- which is what this script is for.
--
-- READ THIS BEFORE RUNNING. `payroll_runs.employee_count` is a denormalised
-- counter and it lies. Exercising an earlier version of this script against a
-- database found six runs with `policy_version_id IS NULL`, `employee_count = 0`
-- and `gross_total = net_total = 0` that nonetheless carried 30
-- `payroll_run_employees` rows, 30 `payroll_line_items` and **five
-- `payslip_publications`** — published payslips on a run the counters described
-- as empty. A delete keyed on the shape BUG-001 describes would have destroyed
-- them; only `payslip_publications`' ON DELETE RESTRICT stopped it. So the
-- candidate predicate below requires `NOT EXISTS` against every dependent table
-- rather than trusting a counter, and STEP 1, STEP 2 and STEP 3 all use that one
-- predicate so they cannot disagree.
--
-- Why a script and not a migration. BE-52 permits a hard delete for an unsent
-- draft, and a run that never began is one — but it is a single tenant's rows, a
-- DELETE has no honest rollback, and BE-66 requires a migration to replay on an
-- empty database, where these rows do not exist. It is an operator action, run
-- once, with its pre-image kept.
--
-- Run STEP 1 and STEP 2 and read them. Only then run STEP 3.
-- Connect as the database owner; the application role is under RLS and cannot see
-- another tenant's rows.
--
--   psql "$DATABASE_URL" -v expected=1 -f BUG-001-ORPHAN-RUN-REMEDIATION.sql

\set ON_ERROR_STOP on

-- The one candidate predicate, defined once. A candidate is a run that never
-- began: no policy version, a status before any approval, no money, no
-- lifecycle timestamp, and no row in any table that references it.
CREATE OR REPLACE VIEW payroll_runs_bug001_candidates AS
SELECT r.*
FROM payroll_runs r
WHERE r.policy_version_id IS NULL
  AND r.status IN ('PREPARING', 'DRAFT')
  AND COALESCE(r.gross_total, 0) = 0
  AND COALESCE(r.net_total, 0) = 0
  AND COALESCE(r.deduction_total, 0) = 0
  AND COALESCE(r.employer_cost_total, 0) = 0
  AND r.locked_at IS NULL
  AND r.approved_at IS NULL
  AND r.paid_at IS NULL
  AND r.published_at IS NULL
  AND r.closed_at IS NULL
  AND r.reopened_at IS NULL
  -- Every dependent, checked directly. `employee_count` is not consulted.
  AND NOT EXISTS (SELECT 1 FROM payroll_run_employees d WHERE d.org_id = r.org_id AND d.run_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM payroll_line_items d WHERE d.org_id = r.org_id AND d.run_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM payslip_publications d WHERE d.org_id = r.org_id AND d.run_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM payroll_tds_ytd_ledger d WHERE d.org_id = r.org_id AND d.run_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM payroll_bank_batches d WHERE d.org_id = r.org_id AND d.run_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM payroll_approvals d WHERE d.org_id = r.org_id AND d.run_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM payroll_journal_batches d WHERE d.org_id = r.org_id AND d.run_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM payroll_inputs d WHERE d.org_id = r.org_id AND d.run_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM payroll_exceptions d WHERE d.org_id = r.org_id AND d.run_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM payroll_run_events d WHERE d.org_id = r.org_id AND d.run_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM payroll_loan_adjustments d WHERE d.org_id = r.org_id AND d.run_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM payroll_command_receipts d WHERE d.org_id = r.org_id AND d.run_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM payroll_runs d WHERE d.org_id = r.org_id AND d.source_run_id = r.id);

-- ---------------------------------------------------------------------------
-- STEP 1 — what will be deleted. Read-only. Count these rows; that is :expected.
-- ---------------------------------------------------------------------------
SELECT id, org_id, month, status, policy_version_id, employee_count, created_at, created_by
FROM payroll_runs_bug001_candidates
ORDER BY org_id, id;

-- ---------------------------------------------------------------------------
-- STEP 2 — the runs this refuses to touch, and why. Read-only.
--
-- Every run matching BUG-001's *described* shape that is NOT a candidate, with
-- the dependent rows that disqualified it. A non-empty result here is the point
-- of this script: those runs hold real data behind counters reading zero, and
-- they need investigating, not deleting.
-- ---------------------------------------------------------------------------
SELECT
  r.id, r.org_id, r.month, r.status, r.employee_count,
  (SELECT COUNT(*) FROM payroll_run_employees d WHERE d.org_id = r.org_id AND d.run_id = r.id) AS run_employees,
  (SELECT COUNT(*) FROM payroll_line_items d WHERE d.org_id = r.org_id AND d.run_id = r.id) AS line_items,
  (SELECT COUNT(*) FROM payslip_publications d WHERE d.org_id = r.org_id AND d.run_id = r.id) AS payslips_published,
  (SELECT COUNT(*) FROM payroll_tds_ytd_ledger d WHERE d.org_id = r.org_id AND d.run_id = r.id) AS tds_ledger,
  (SELECT COUNT(*) FROM payroll_bank_batches d WHERE d.org_id = r.org_id AND d.run_id = r.id) AS bank_batches
FROM payroll_runs r
WHERE r.policy_version_id IS NULL
  AND r.status IN ('PREPARING', 'DRAFT')
  AND NOT EXISTS (SELECT 1 FROM payroll_runs_bug001_candidates c WHERE c.org_id = r.org_id AND c.id = r.id)
ORDER BY r.org_id, r.id;

-- ---------------------------------------------------------------------------
-- STEP 3 — delete, with the pre-image kept and the count asserted.
--
-- The transaction aborts unless exactly :expected rows are removed, so a row that
-- changed since STEP 1 stops the operation instead of going unseen.
-- `payroll_runs_bug001_preimage` is the audit trail — a plain table, not a temp
-- table, so it outlives the session. Keep it.
-- ---------------------------------------------------------------------------
BEGIN;

SET LOCAL lock_timeout = '5s';
-- psql does not interpolate :expected inside a dollar-quoted block, so it is
-- carried in through a session GUC that the block reads back.
SET LOCAL bug001.expected = :expected;

CREATE TABLE IF NOT EXISTS payroll_runs_bug001_preimage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  removed_at timestamptz NOT NULL DEFAULT now(),
  removed_by text NOT NULL DEFAULT current_user,
  run jsonb NOT NULL
);

-- Freeze the candidate set first, so the pre-image, the delete and the assertion
-- all act on one identical list even if the view would re-evaluate differently.
CREATE TEMP TABLE bug001_candidates ON COMMIT DROP AS
SELECT * FROM payroll_runs_bug001_candidates;

INSERT INTO payroll_runs_bug001_preimage (run)
SELECT to_jsonb(c) FROM bug001_candidates c;

DELETE FROM payroll_runs r
USING bug001_candidates c
WHERE r.org_id = c.org_id AND r.id = c.id;

DO $$
DECLARE
  planned int;
  survivors int;
  expected int := current_setting('bug001.expected')::int;
BEGIN
  SELECT COUNT(*) INTO planned FROM bug001_candidates;
  IF planned <> expected THEN
    RAISE EXCEPTION
      'refusing to commit: expected % orphan run(s), this transaction matched % — re-read STEP 1',
      expected, planned;
  END IF;
  SELECT COUNT(*) INTO survivors
  FROM payroll_runs r JOIN bug001_candidates c ON c.org_id = r.org_id AND c.id = r.id;
  IF survivors <> 0 THEN
    RAISE EXCEPTION 'refusing to commit: % of % run(s) were not removed', survivors, planned;
  END IF;
  RAISE NOTICE 'removed % orphan payroll run(s); pre-image kept in payroll_runs_bug001_preimage', planned;
END $$;

COMMIT;

-- ---------------------------------------------------------------------------
-- STEP 4 — confirm. Read-only.
-- ---------------------------------------------------------------------------
SELECT COUNT(*) AS candidates_remaining FROM payroll_runs_bug001_candidates;

SELECT removed_at, removed_by, run->>'org_id' AS org_id, run->>'id' AS run_id, run->>'month' AS month
FROM payroll_runs_bug001_preimage
ORDER BY removed_at DESC, (run->>'id')::int;

-- The view is a helper for this operation only.
DROP VIEW payroll_runs_bug001_candidates;
