DROP INDEX IF EXISTS public.idx_invoices_deal;

ALTER TABLE public.invoices
  DROP COLUMN IF EXISTS deal_id;
