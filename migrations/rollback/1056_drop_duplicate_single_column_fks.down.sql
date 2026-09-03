-- 1056 DOWN — recreates the eleven duplicate foreign keys 1056 removed.
--
-- @reopens-a-defect: every one of these duplicates a constraint that is still in place,
-- so running this file restores the second referential-integrity trigger on each
-- relationship. Measured cost at head: about 10% of an INSERT into
-- fin_reimbursement_batches, and a second identical ON DELETE CASCADE pass over each of
-- the nine duplicated child tables on every DELETE FROM organizations. There is no
-- correctness reason to run it. It exists so the forward migration is reversible.
--
-- No data is at risk in either direction. Each constraint recreated here is
-- definitionally identical to one that never left, so it can neither reject a row the
-- surviving constraint accepts nor accept one it rejects.
--
-- Each ADD CONSTRAINT is written NOT VALID and validated separately
-- (check-migration-discipline rule 2): the unqualified form takes ACCESS EXCLUSIVE on
-- both tables for the whole trigger-install and validation pass, and nine of these
-- reference organizations. IF NOT EXISTS guards let the file run on a database where
-- 1056 was never applied.
--
-- feedback_cycle_responses_org_id_fk is recreated under its original name even though
-- the Drizzle declaration names it feedback_cycle_responses_org_id_organizations_id_fk;
-- a rollback restores what was there, it does not improve on it.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  pair RECORD;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('build',  'project_members',           'project_members_org_id_fk',                  'org_id',      'public', 'organizations', 'id', ' ON DELETE CASCADE'),
      ('build',  'project_template_tickets',  'project_template_tickets_org_id_fk',         'org_id',      'public', 'organizations', 'id', ' ON DELETE CASCADE'),
      ('public', 'exit_checklists',           'exit_checklists_org_id_fk',                  'org_id',      'public', 'organizations', 'id', ' ON DELETE CASCADE'),
      ('public', 'feedback_cycle_responses',  'feedback_cycle_responses_org_id_fk',         'org_id',      'public', 'organizations', 'id', ' ON DELETE CASCADE'),
      ('public', 'fin_expense_policies',      'fin_expense_policies_org_id_fkey',           'org_id',      'public', 'organizations', 'id', ' ON DELETE CASCADE'),
      ('public', 'fin_reimbursement_batches', 'fin_reimbursement_batches_org_id_fkey',      'org_id',      'public', 'organizations', 'id', ' ON DELETE CASCADE'),
      ('public', 'fin_reimbursement_batches', 'fin_reimbursement_batches_created_by_fkey',  'created_by',  'public', 'users',         'id', ''),
      ('public', 'fin_reimbursement_batches', 'fin_reimbursement_batches_approved_by_fkey', 'approved_by', 'public', 'users',         'id', ''),
      ('public', 'invitation_events',         'fk_invitation_events_org',                   'org_id',      'public', 'organizations', 'id', ' ON DELETE CASCADE'),
      ('public', 'workflow_variables',        'workflow_variables_org_id_fk',               'org_id',      'public', 'organizations', 'id', ' ON DELETE CASCADE'),
      ('public', 'workflow_versions',         'workflow_versions_org_id_fk',                'org_id',      'public', 'organizations', 'id', ' ON DELETE CASCADE')
    ) AS t(nsp, child, name, col, pnsp, parent, pcol, action)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
       WHERE n.nspname = pair.nsp AND r.relname = pair.child AND c.conname = pair.name
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I.%I (%I)%s NOT VALID',
      pair.nsp, pair.child, pair.name, pair.col, pair.pnsp, pair.parent, pair.pcol, pair.action);
    EXECUTE format('ALTER TABLE %I.%I VALIDATE CONSTRAINT %I', pair.nsp, pair.child, pair.name);
  END LOOP;
END
$$;
