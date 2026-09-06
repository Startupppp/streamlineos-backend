-- 1063 DOWN — drops the invoice-item immutability trigger and its backing function.
--
-- @reopens-a-defect: the database-level backstop against rewriting or deleting line
-- items of non-draft invoices is removed. The application service still refuses it, but
-- a raw UPDATE, a future service path, or a repair script can silently diverge the stored
-- line justification from the frozen invoice total without an error at the DB layer.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_invoice_item_immutability ON invoice_items;
--> statement-breakpoint

DROP FUNCTION IF EXISTS enforce_invoice_item_immutability();
