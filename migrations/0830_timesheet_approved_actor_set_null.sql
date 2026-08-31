-- 0830: Change timesheets.approved_by_membership_id and
-- timesheet_periods.approved_by_membership_id FKs from RESTRICT to SET NULL.
--
-- Ruling: CHANGE TO SET NULL.
-- Both columns are approval-attribution. The timesheet and period records must
-- survive for payroll processing and audit after a member leaves; only the
-- membership pointer is cleared. A parallel user column (approved_by) preserves
-- the approver identity for display purposes.
SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.timesheets
  DROP CONSTRAINT IF EXISTS fk_timesheets_approved_actor;
--> statement-breakpoint
ALTER TABLE public.timesheets
  ADD CONSTRAINT fk_timesheets_approved_actor
    FOREIGN KEY (org_id, approved_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (approved_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.timesheets
  VALIDATE CONSTRAINT fk_timesheets_approved_actor;
--> statement-breakpoint

ALTER TABLE public.timesheet_periods
  DROP CONSTRAINT IF EXISTS fk_timesheet_periods_approved_actor;
--> statement-breakpoint
ALTER TABLE public.timesheet_periods
  ADD CONSTRAINT fk_timesheet_periods_approved_actor
    FOREIGN KEY (org_id, approved_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (approved_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.timesheet_periods
  VALIDATE CONSTRAINT fk_timesheet_periods_approved_actor;
--> statement-breakpoint

DO $$
DECLARE
  wrong_del text;
BEGIN
  SELECT c.confdeltype INTO wrong_del
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  WHERE c.conname = 'fk_timesheets_approved_actor' AND c.contype = 'f'
    AND r.relname = 'timesheets';
  IF wrong_del IS DISTINCT FROM 'n' THEN
    RAISE EXCEPTION '0830: fk_timesheets_approved_actor confdeltype = % (expected n=SET NULL)', wrong_del;
  END IF;

  SELECT c.confdeltype INTO wrong_del
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  WHERE c.conname = 'fk_timesheet_periods_approved_actor' AND c.contype = 'f'
    AND r.relname = 'timesheet_periods';
  IF wrong_del IS DISTINCT FROM 'n' THEN
    RAISE EXCEPTION '0830: fk_timesheet_periods_approved_actor confdeltype = % (expected n=SET NULL)', wrong_del;
  END IF;
END $$;
