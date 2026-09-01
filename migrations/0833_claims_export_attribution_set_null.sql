-- 0833: Change reimbursements, finance_report_export_jobs, and
-- payroll_run_export_jobs requester/approver FKs from RESTRICT to SET NULL.
--
-- Ruling: CHANGE TO SET NULL.
-- reimbursements.approved_by_membership_id: approval attribution; parallel
--   user column (approved_by) preserves identity for display.
-- finance_report_export_jobs.requested_by_membership_id: requester attribution;
--   the export job record is preserved.
-- payroll_run_export_jobs.requested_by_membership_id: same as above.
SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.reimbursements
  DROP CONSTRAINT IF EXISTS fk_reimbursements_approved_actor;
--> statement-breakpoint
ALTER TABLE public.reimbursements
  ADD CONSTRAINT fk_reimbursements_approved_actor
    FOREIGN KEY (org_id, approved_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (approved_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.reimbursements
  VALIDATE CONSTRAINT fk_reimbursements_approved_actor;
--> statement-breakpoint

ALTER TABLE public.finance_report_export_jobs
  ALTER COLUMN requested_by_membership_id DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE public.finance_report_export_jobs
  DROP CONSTRAINT IF EXISTS fin_report_export_jobs_org_requester_membership_fk;
--> statement-breakpoint
ALTER TABLE public.finance_report_export_jobs
  ADD CONSTRAINT fin_report_export_jobs_org_requester_membership_fk
    FOREIGN KEY (org_id, requested_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (requested_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.finance_report_export_jobs
  VALIDATE CONSTRAINT fin_report_export_jobs_org_requester_membership_fk;
--> statement-breakpoint

ALTER TABLE public.payroll_run_export_jobs
  ALTER COLUMN requested_by_membership_id DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE public.payroll_run_export_jobs
  DROP CONSTRAINT IF EXISTS payroll_run_export_jobs_org_requester_membership_fk;
--> statement-breakpoint
ALTER TABLE public.payroll_run_export_jobs
  ADD CONSTRAINT payroll_run_export_jobs_org_requester_membership_fk
    FOREIGN KEY (org_id, requested_by_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (requested_by_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_run_export_jobs
  VALIDATE CONSTRAINT payroll_run_export_jobs_org_requester_membership_fk;
--> statement-breakpoint

DO $$
DECLARE
  wrong_del text;
BEGIN
  SELECT c.confdeltype INTO wrong_del
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  WHERE c.conname = 'fk_reimbursements_approved_actor' AND c.contype = 'f'
    AND r.relname = 'reimbursements';
  IF wrong_del IS DISTINCT FROM 'n' THEN
    RAISE EXCEPTION '0833: fk_reimbursements_approved_actor confdeltype = % (expected n)', wrong_del;
  END IF;

  SELECT c.confdeltype INTO wrong_del
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  WHERE c.conname = 'fin_report_export_jobs_org_requester_membership_fk' AND c.contype = 'f'
    AND r.relname = 'finance_report_export_jobs';
  IF wrong_del IS DISTINCT FROM 'n' THEN
    RAISE EXCEPTION '0833: fin_report_export_jobs_org_requester_membership_fk confdeltype = % (expected n)', wrong_del;
  END IF;

  SELECT c.confdeltype INTO wrong_del
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  WHERE c.conname = 'payroll_run_export_jobs_org_requester_membership_fk' AND c.contype = 'f'
    AND r.relname = 'payroll_run_export_jobs';
  IF wrong_del IS DISTINCT FROM 'n' THEN
    RAISE EXCEPTION '0833: payroll_run_export_jobs_org_requester_membership_fk confdeltype = % (expected n)', wrong_del;
  END IF;
END $$;
