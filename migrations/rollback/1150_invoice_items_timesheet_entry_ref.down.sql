DROP INDEX IF EXISTS public.idx_invoice_items_timesheet_entry;

ALTER TABLE public.invoice_items
  DROP COLUMN IF EXISTS timesheet_entry_id;
