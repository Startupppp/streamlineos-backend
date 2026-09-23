-- Migration 1165: deal_id on invoices for freelancer client/deal traceability
-- Rollback: migrations/rollback/1165_invoices_deal_id.down.sql
--
-- Closes the "no canonical deal linkage" gap in the freelancer chain (client /
-- project / deal -> approved time -> invoice): an invoice can now carry the
-- CRM deal it was generated from, the same shape `quotes.deal_id` already
-- uses (db/schema/crm/deals.ts). Composite on (org_id, deal_id), matching
-- 1150's reasoning for invoice_items.timesheet_entry_id -- a single-column
-- reference would let an invoice in one organization point at another
-- organization's deal.
--
-- ON DELETE SET NULL names its column list explicitly. Without it Postgres
-- nulls every column in the key, including the NOT NULL org_id, which fails
-- 23502 at delete time.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS deal_id INTEGER;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_invoices_deal
  ON public.invoices (org_id, deal_id)
  WHERE deal_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS fk_invoices_org_deal;
--> statement-breakpoint

ALTER TABLE public.invoices
  ADD CONSTRAINT fk_invoices_org_deal
    FOREIGN KEY (org_id, deal_id)
    REFERENCES public.deals (org_id, id)
    ON DELETE SET NULL (deal_id)
    NOT VALID;
