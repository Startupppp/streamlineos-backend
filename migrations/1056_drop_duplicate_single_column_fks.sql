-- 1056 — drops eleven foreign keys that are exact duplicates of another foreign key
--        on the same table, so each relationship is enforced once instead of twice.
--
-- WHAT WAS WRONG. Two authorities have been writing the same relationships. Drizzle
-- names an inline `.references()` `<child>_<col>_<parent>_<parentcol>_fk`; Postgres'
-- own default is `<child>_<col>_fkey`; and repair migrations that walked the catalog
-- adding tenant constraints by hand chose `<child>_org_id_fk` or `fk_<child>_org`.
-- 0320_recon_phase_a_orgid.sql is the clearest example — its loop guards only on the
-- NAME it is about to use (`IF NOT EXISTS (... WHERE conname=fkname ...)`, line 57),
-- never on whether an equivalent foreign key on that column already exists, so it
-- added a second identical constraint wherever one was already there under another
-- name. 0619_chain_creates_what_production_has.sql does the same with `_fkey` names.
--
-- Measured at journal head 677 over all 1,677 single-column foreign keys, grouping on
-- every semantic attribute (conkey, confkey, confupdtype, confdeltype, confmatchtype,
-- condeferrable, condeferred, convalidated, confdelsetcols): 22 constraints form 11
-- exact-duplicate pairs. Postgres installs referential-integrity triggers per
-- CONSTRAINT, not per relationship, so it reports the cost itself. One INSERT into
-- fin_reimbursement_batches, EXPLAIN (ANALYZE) at head:
--
--   Trigger for constraint fin_reimbursement_batches_org_id_organizations_id_fk: 0.371 ms
--   Trigger for constraint fin_reimbursement_batches_created_by_users_id_fk:     0.050 ms
--   Trigger for constraint fin_reimbursement_batches_approved_by_users_id_fk:    0.026 ms
--   Trigger for constraint fin_reimbursement_batches_org_id_fkey:                0.245 ms   <- duplicate
--   Trigger for constraint fin_reimbursement_batches_created_by_fkey:            0.163 ms   <- duplicate
--   Trigger for constraint fin_reimbursement_batches_approved_by_fkey:           0.109 ms   <- duplicate
--   ... Execution Time: 4.905 ms
--
-- 0.517 ms of 4.905 ms — about 10% of that insert — bought nothing. The same doubling
-- applies to every DELETE FROM organizations, which runs two identical ON DELETE
-- CASCADE passes over each of the nine duplicated child tables and takes two ROW SHARE
-- locks where one would do.
--
-- WHY NO GATE SEES IT. check:declaration-constraint-drift matches foreign keys by NAME
-- ONLY, so the second name is filed under "live-but-undeclared" (1,187 objects) which
-- that gate reports and never fails. The naming split IS the evidence: a relationship
-- written by one authority does not acquire two names.
--
-- WHY THE DROP IS UNOBSERVABLE. Each surviving constraint is identical to the one
-- dropped in every column pg_constraint records — same child, same column, same
-- parent, same referenced column, same ON DELETE, same ON UPDATE, same MATCH, same
-- deferrability, same validated state. Enforcement after this migration is exactly
-- what it was before; only the duplicate trigger pair is gone. The DO block below
-- re-proves that per pair against the database it is running on and REFUSES rather
-- than dropping if the two are not identical or the survivor is missing, so a database
-- that drifted differently cannot lose a constraint here. No code names any of the
-- dropped constraints: grepped across src/, migrations/, contracts/ and every gate
-- baseline, the only hits are the migrations that created them, all of which run
-- earlier than this one.
--
-- WHICH NAME SURVIVES. The one the Drizzle declaration produces, for ten of the eleven,
-- so the catalog moves toward the declaration rather than away from it. The exception
-- is feedback_cycle_responses, where the declared name
-- (feedback_cycle_responses_org_id_organizations_id_fk) is absent at head and BOTH live
-- names are undeclared; there the survivor is fk_feedback_cycle_responses_org because
-- 0678 and 0678b manage that constraint by name as part of the RLS completion, and
-- 0678b's IF NOT EXISTS guard keys on it. Renaming it to the declared form is a
-- separate question from removing the duplicate and is not attempted here.
--
-- LOCKING. ALTER TABLE ... DROP CONSTRAINT takes ACCESS EXCLUSIVE on the child and on
-- the referenced parent, because the RI triggers live on both. Nine of these reference
-- organizations, so that table is briefly locked. The work is catalog-only — no table
-- is scanned or rewritten — and lock_timeout bounds the wait.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  pair RECORD;
  keep_def text;
  drop_def text;
  keep_valid boolean;
  drop_valid boolean;
  dropped int := 0;
  absent int := 0;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('build',  'project_members',           'project_members_org_id_organizations_id_fk',           'project_members_org_id_fk'),
      ('build',  'project_template_tickets',  'project_template_tickets_org_id_organizations_id_fk',  'project_template_tickets_org_id_fk'),
      ('public', 'exit_checklists',           'exit_checklists_org_id_organizations_id_fk',           'exit_checklists_org_id_fk'),
      ('public', 'feedback_cycle_responses',  'fk_feedback_cycle_responses_org',                      'feedback_cycle_responses_org_id_fk'),
      ('public', 'fin_expense_policies',      'fin_expense_policies_org_id_organizations_id_fk',      'fin_expense_policies_org_id_fkey'),
      ('public', 'fin_reimbursement_batches', 'fin_reimbursement_batches_org_id_organizations_id_fk', 'fin_reimbursement_batches_org_id_fkey'),
      ('public', 'fin_reimbursement_batches', 'fin_reimbursement_batches_created_by_users_id_fk',     'fin_reimbursement_batches_created_by_fkey'),
      ('public', 'fin_reimbursement_batches', 'fin_reimbursement_batches_approved_by_users_id_fk',    'fin_reimbursement_batches_approved_by_fkey'),
      ('public', 'invitation_events',         'invitation_events_org_id_organizations_id_fk',         'fk_invitation_events_org'),
      ('public', 'workflow_variables',        'workflow_variables_org_id_organizations_id_fk',        'workflow_variables_org_id_fk'),
      ('public', 'workflow_versions',         'workflow_versions_org_id_organizations_id_fk',         'workflow_versions_org_id_fk')
    ) AS t(nsp, child, keep_name, drop_name)
  LOOP
    SELECT pg_get_constraintdef(c.oid), c.convalidated INTO drop_def, drop_valid
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
     WHERE n.nspname = pair.nsp AND r.relname = pair.child
       AND c.conname = pair.drop_name AND c.contype = 'f';

    IF drop_def IS NULL THEN
      -- Never created on this database, or already removed. Nothing to prove.
      absent := absent + 1;
      CONTINUE;
    END IF;

    SELECT pg_get_constraintdef(c.oid), c.convalidated INTO keep_def, keep_valid
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
     WHERE n.nspname = pair.nsp AND r.relname = pair.child
       AND c.conname = pair.keep_name AND c.contype = 'f';

    IF keep_def IS NULL THEN
      RAISE EXCEPTION
        '1056: refusing to drop %.%.% — the constraint that should survive (%) does not exist on this database',
        pair.nsp, pair.child, pair.drop_name, pair.keep_name
        USING HINT = 'Dropping the duplicate would remove the relationship entirely. Investigate before re-running.';
    END IF;

    IF keep_def IS DISTINCT FROM drop_def OR keep_valid IS DISTINCT FROM drop_valid THEN
      RAISE EXCEPTION
        '1056: refusing to drop %.%.% — it is NOT a duplicate here. keep(%) = % validated=%, drop = % validated=%',
        pair.nsp, pair.child, pair.drop_name, pair.keep_name, keep_def, keep_valid, drop_def, drop_valid
        USING HINT = 'The two constraints differ, so removing one changes enforcement. Investigate before re-running.';
    END IF;

    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', pair.nsp, pair.child, pair.drop_name);
    dropped := dropped + 1;
  END LOOP;

  RAISE NOTICE '1056: dropped % duplicate foreign key(s); % were already absent', dropped, absent;
END
$$;
--> statement-breakpoint

-- Read the catalog back rather than trusting completion: a DO block that took every
-- CONTINUE branch reports success having changed nothing.
DO $$
DECLARE
  survivors int;
  leftovers int;
  remaining_dupes int;
BEGIN
  SELECT count(*) INTO survivors
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
   WHERE c.contype = 'f'
     AND (n.nspname, r.relname, c.conname) IN (
       ('build','project_members','project_members_org_id_organizations_id_fk'),
       ('build','project_template_tickets','project_template_tickets_org_id_organizations_id_fk'),
       ('public','exit_checklists','exit_checklists_org_id_organizations_id_fk'),
       ('public','feedback_cycle_responses','fk_feedback_cycle_responses_org'),
       ('public','fin_expense_policies','fin_expense_policies_org_id_organizations_id_fk'),
       ('public','fin_reimbursement_batches','fin_reimbursement_batches_org_id_organizations_id_fk'),
       ('public','fin_reimbursement_batches','fin_reimbursement_batches_created_by_users_id_fk'),
       ('public','fin_reimbursement_batches','fin_reimbursement_batches_approved_by_users_id_fk'),
       ('public','invitation_events','invitation_events_org_id_organizations_id_fk'),
       ('public','workflow_variables','workflow_variables_org_id_organizations_id_fk'),
       ('public','workflow_versions','workflow_versions_org_id_organizations_id_fk')
     );

  IF survivors <> 11 THEN
    RAISE EXCEPTION '1056: expected 11 surviving foreign keys, found % — a relationship was lost', survivors;
  END IF;

  SELECT count(*) INTO leftovers
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
   WHERE c.contype = 'f'
     AND (n.nspname, r.relname, c.conname) IN (
       ('build','project_members','project_members_org_id_fk'),
       ('build','project_template_tickets','project_template_tickets_org_id_fk'),
       ('public','exit_checklists','exit_checklists_org_id_fk'),
       ('public','feedback_cycle_responses','feedback_cycle_responses_org_id_fk'),
       ('public','fin_expense_policies','fin_expense_policies_org_id_fkey'),
       ('public','fin_reimbursement_batches','fin_reimbursement_batches_org_id_fkey'),
       ('public','fin_reimbursement_batches','fin_reimbursement_batches_created_by_fkey'),
       ('public','fin_reimbursement_batches','fin_reimbursement_batches_approved_by_fkey'),
       ('public','invitation_events','fk_invitation_events_org'),
       ('public','workflow_variables','workflow_variables_org_id_fk'),
       ('public','workflow_versions','workflow_versions_org_id_fk')
     );

  IF leftovers <> 0 THEN
    RAISE EXCEPTION '1056: % duplicate foreign key(s) survived the drop', leftovers;
  END IF;

  -- Reported, not enforced: a duplicate on some other database is worth seeing in the
  -- deploy log, but it must not block this migration, which is scoped to eleven names.
  SELECT count(*) INTO remaining_dupes FROM (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
     WHERE c.contype = 'f'
       AND array_length(c.conkey, 1) = 1
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     GROUP BY c.conrelid, c.confrelid, c.conkey, c.confkey, c.confupdtype, c.confdeltype,
              c.confmatchtype, c.condeferrable, c.condeferred, c.convalidated, c.confdelsetcols
    HAVING count(*) > 1
  ) d;

  RAISE NOTICE '1056: % exact-duplicate single-column foreign key group(s) remain', remaining_dupes;
END
$$;
