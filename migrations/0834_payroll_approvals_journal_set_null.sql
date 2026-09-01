-- 0834: Change payroll_approvals and payroll_journal_batches actor FKs
-- from RESTRICT to SET NULL.
--
-- Ruling: CHANGE TO SET NULL.
-- payroll_approvals.acted_by_membership_id: records which membership approved a
--   payroll stage. The approval is a historical fact; clearing the membership
--   pointer does not un-approve the run. Financial retention is satisfied by the
--   run-level user columns (acted_by, paid_by etc.) that reference users.id directly.
-- payroll_journal_batches.*_by_membership_id (×5): same reasoning — the batch
--   record is the audit artifact; each has a parallel user column.
SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.payroll_approvals
  DROP CONSTRAINT IF EXISTS fk_payroll_approvals_acted_actor;
--> statement-breakpoint
ALTER TABLE public.payroll_approvals
  ADD CONSTRAINT fk_payroll_approvals_acted_actor
    FOREIGN KEY (org_id, acted_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (acted_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_approvals
  VALIDATE CONSTRAINT fk_payroll_approvals_acted_actor;
--> statement-breakpoint

ALTER TABLE public.payroll_journal_batches
  DROP CONSTRAINT IF EXISTS fk_payroll_jrnl_batches_posted_actor;
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches
  ADD CONSTRAINT fk_payroll_jrnl_batches_posted_actor
    FOREIGN KEY (org_id, posted_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (posted_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches
  VALIDATE CONSTRAINT fk_payroll_jrnl_batches_posted_actor;
--> statement-breakpoint

ALTER TABLE public.payroll_journal_batches
  DROP CONSTRAINT IF EXISTS fk_payroll_jrnl_batches_exported_actor;
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches
  ADD CONSTRAINT fk_payroll_jrnl_batches_exported_actor
    FOREIGN KEY (org_id, exported_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (exported_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches
  VALIDATE CONSTRAINT fk_payroll_jrnl_batches_exported_actor;
--> statement-breakpoint

ALTER TABLE public.payroll_journal_batches
  DROP CONSTRAINT IF EXISTS fk_payroll_jrnl_batches_reversed_actor;
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches
  ADD CONSTRAINT fk_payroll_jrnl_batches_reversed_actor
    FOREIGN KEY (org_id, reversed_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (reversed_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches
  VALIDATE CONSTRAINT fk_payroll_jrnl_batches_reversed_actor;
--> statement-breakpoint

ALTER TABLE public.payroll_journal_batches
  DROP CONSTRAINT IF EXISTS fk_payroll_jrnl_batches_reconciled_actor;
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches
  ADD CONSTRAINT fk_payroll_jrnl_batches_reconciled_actor
    FOREIGN KEY (org_id, reconciled_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (reconciled_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches
  VALIDATE CONSTRAINT fk_payroll_jrnl_batches_reconciled_actor;
--> statement-breakpoint

ALTER TABLE public.payroll_journal_batches
  DROP CONSTRAINT IF EXISTS fk_payroll_jrnl_batches_created_actor;
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches
  ADD CONSTRAINT fk_payroll_jrnl_batches_created_actor
    FOREIGN KEY (org_id, created_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (created_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches
  VALIDATE CONSTRAINT fk_payroll_jrnl_batches_created_actor;
--> statement-breakpoint

DO $$
DECLARE
  wrong_del text;
  cnames text[] := ARRAY[
    'fk_payroll_approvals_acted_actor',
    'fk_payroll_jrnl_batches_posted_actor',
    'fk_payroll_jrnl_batches_exported_actor',
    'fk_payroll_jrnl_batches_reversed_actor',
    'fk_payroll_jrnl_batches_reconciled_actor',
    'fk_payroll_jrnl_batches_created_actor'
  ];
  cname text;
BEGIN
  FOREACH cname IN ARRAY cnames LOOP
    SELECT c.confdeltype INTO wrong_del
    FROM pg_constraint c
    WHERE c.conname = cname AND c.contype = 'f';
    IF wrong_del IS DISTINCT FROM 'n' THEN
      RAISE EXCEPTION '0834: % confdeltype = % (expected n=SET NULL)', cname, wrong_del;
    END IF;
  END LOOP;
END $$;
