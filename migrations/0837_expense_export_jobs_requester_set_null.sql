-- 0837: Change expense_export_jobs requester FK from RESTRICT to SET NULL.
--
-- Ruling: CHANGE TO SET NULL.
-- expense_export_jobs.requested_by_membership_id: requester attribution; the
-- export job record is preserved after the requester leaves the org.
-- Column is made nullable first; the FK is then re-added as SET NULL.
SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.expense_export_jobs
  ALTER COLUMN requested_by_membership_id DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE public.expense_export_jobs
  DROP CONSTRAINT IF EXISTS expense_export_jobs_org_requester_membership_fk;
--> statement-breakpoint

ALTER TABLE public.expense_export_jobs
  ADD CONSTRAINT expense_export_jobs_org_requester_membership_fk
    FOREIGN KEY (org_id, requested_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (requested_by_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE public.expense_export_jobs
  VALIDATE CONSTRAINT expense_export_jobs_org_requester_membership_fk;
--> statement-breakpoint

DO $$
DECLARE
  wrong_del text;
BEGIN
  SELECT c.confdeltype INTO wrong_del
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  WHERE c.conname = 'expense_export_jobs_org_requester_membership_fk'
    AND c.contype = 'f'
    AND r.relname = 'expense_export_jobs';
  IF wrong_del IS DISTINCT FROM 'n' THEN
    RAISE EXCEPTION '0837: expense_export_jobs_org_requester_membership_fk confdeltype = % (expected n)', wrong_del;
  END IF;
END $$;
