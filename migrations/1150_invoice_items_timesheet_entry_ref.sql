-- Migration 1150: timesheet_entry_id on invoice_items for approved-time traceability
-- Rollback: migrations/rollback/1150_invoice_items_timesheet_entry_ref.sql

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS timesheet_entry_id INTEGER
    REFERENCES public.timesheets(id) ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_invoice_items_timesheet_entry
  ON public.invoice_items (timesheet_entry_id)
  WHERE timesheet_entry_id IS NOT NULL;
