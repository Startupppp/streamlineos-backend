-- 0835: Change all seven payroll_runs actor FKs from RESTRICT to SET NULL.
--
-- Ruling: CHANGE TO SET NULL.
-- Six FKs were in the Drizzle schema (approved, paid, published, closed,
-- reopened, created). A seventh (locked) was added by migration 0811 but
-- was missing from the schema file (schema/DB drift). All seven record which
-- membership performed a lifecycle action on the run. Financial retention is
-- satisfied by the parallel user columns (approved_by, paid_by, etc.) that
-- reference users.id directly and are not affected by this change.
-- The locked_by FK is also added to the Drizzle schema as SET NULL.
SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.payroll_runs
  DROP CONSTRAINT IF EXISTS fk_payroll_runs_approved_actor;
--> statement-breakpoint
ALTER TABLE public.payroll_runs
  ADD CONSTRAINT fk_payroll_runs_approved_actor
    FOREIGN KEY (org_id, approved_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (approved_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_runs
  VALIDATE CONSTRAINT fk_payroll_runs_approved_actor;
--> statement-breakpoint

ALTER TABLE public.payroll_runs
  DROP CONSTRAINT IF EXISTS fk_payroll_runs_paid_actor;
--> statement-breakpoint
ALTER TABLE public.payroll_runs
  ADD CONSTRAINT fk_payroll_runs_paid_actor
    FOREIGN KEY (org_id, paid_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (paid_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_runs
  VALIDATE CONSTRAINT fk_payroll_runs_paid_actor;
--> statement-breakpoint

ALTER TABLE public.payroll_runs
  DROP CONSTRAINT IF EXISTS fk_payroll_runs_published_actor;
--> statement-breakpoint
ALTER TABLE public.payroll_runs
  ADD CONSTRAINT fk_payroll_runs_published_actor
    FOREIGN KEY (org_id, published_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (published_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_runs
  VALIDATE CONSTRAINT fk_payroll_runs_published_actor;
--> statement-breakpoint

ALTER TABLE public.payroll_runs
  DROP CONSTRAINT IF EXISTS fk_payroll_runs_closed_actor;
--> statement-breakpoint
ALTER TABLE public.payroll_runs
  ADD CONSTRAINT fk_payroll_runs_closed_actor
    FOREIGN KEY (org_id, closed_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (closed_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_runs
  VALIDATE CONSTRAINT fk_payroll_runs_closed_actor;
--> statement-breakpoint

ALTER TABLE public.payroll_runs
  DROP CONSTRAINT IF EXISTS fk_payroll_runs_reopened_actor;
--> statement-breakpoint
ALTER TABLE public.payroll_runs
  ADD CONSTRAINT fk_payroll_runs_reopened_actor
    FOREIGN KEY (org_id, reopened_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (reopened_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_runs
  VALIDATE CONSTRAINT fk_payroll_runs_reopened_actor;
--> statement-breakpoint

ALTER TABLE public.payroll_runs
  DROP CONSTRAINT IF EXISTS fk_payroll_runs_created_actor;
--> statement-breakpoint
ALTER TABLE public.payroll_runs
  ADD CONSTRAINT fk_payroll_runs_created_actor
    FOREIGN KEY (org_id, created_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (created_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_runs
  VALIDATE CONSTRAINT fk_payroll_runs_created_actor;
--> statement-breakpoint

ALTER TABLE public.payroll_runs
  DROP CONSTRAINT IF EXISTS fk_payroll_runs_locked_actor;
--> statement-breakpoint
ALTER TABLE public.payroll_runs
  ADD CONSTRAINT fk_payroll_runs_locked_actor
    FOREIGN KEY (org_id, locked_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (locked_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_runs
  VALIDATE CONSTRAINT fk_payroll_runs_locked_actor;
--> statement-breakpoint

DO $$
DECLARE
  wrong_del text;
  cnames text[] := ARRAY[
    'fk_payroll_runs_approved_actor',
    'fk_payroll_runs_paid_actor',
    'fk_payroll_runs_published_actor',
    'fk_payroll_runs_closed_actor',
    'fk_payroll_runs_reopened_actor',
    'fk_payroll_runs_created_actor',
    'fk_payroll_runs_locked_actor'
  ];
  cname text;
BEGIN
  FOREACH cname IN ARRAY cnames LOOP
    SELECT c.confdeltype INTO wrong_del
    FROM pg_constraint c
    WHERE c.conname = cname AND c.contype = 'f';
    IF wrong_del IS DISTINCT FROM 'n' THEN
      RAISE EXCEPTION '0835: % confdeltype = % (expected n=SET NULL)', cname, wrong_del;
    END IF;
  END LOOP;
END $$;
