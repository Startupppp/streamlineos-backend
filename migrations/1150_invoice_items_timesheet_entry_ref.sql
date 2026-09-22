-- Migration 1150: timesheet_entry_id on invoice_items for approved-time traceability
-- Rollback: migrations/rollback/1150_invoice_items_timesheet_entry_ref.down.sql
--
-- The foreign key is composite on (org_id, timesheet_entry_id) rather than the
-- entry id alone. invoice_items carries org_id, so a single-column reference
-- would let an invoice line in one organization point at another organization's
-- timesheet. 0954_ar02_hr_payroll_timesheet_composite_fks established the
-- composite form for every other referrer of timesheets and this follows it.
--
-- ON DELETE SET NULL names its column list explicitly. Without it Postgres
-- nulls every column in the key, including the NOT NULL org_id, which fails
-- 23502 at delete time.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS timesheet_entry_id INTEGER;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_invoice_items_timesheet_entry
  ON public.invoice_items (org_id, timesheet_entry_id)
  WHERE timesheet_entry_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.invoice_items
  DROP CONSTRAINT IF EXISTS fk_invoice_items_org_timesheet_entry;
--> statement-breakpoint

ALTER TABLE public.invoice_items
  ADD CONSTRAINT fk_invoice_items_org_timesheet_entry
    FOREIGN KEY (org_id, timesheet_entry_id)
    REFERENCES public.timesheets (org_id, id)
    ON DELETE SET NULL (timesheet_entry_id)
    NOT VALID;
