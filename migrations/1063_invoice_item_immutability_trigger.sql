-- 1063 — invoice line items are immutable once their invoice leaves DRAFT
-- =============================================================================
-- Ticket: 10-billing-payments / PRD-C125 (immutable invoices)
--
-- 0492 froze the money columns on `invoices`, but what the customer was actually
-- billed for lives one table down. `invoice_items` carried no trigger at all
-- (`trg_set_org_id` only), so the totals on an issued invoice were locked while
-- the lines that justify them could still be rewritten or deleted underneath
-- them. The application refuses it (`invoices-update.service.ts` throws
-- "Only draft invoices can be edited" before touching the lines) — this is the
-- backstop for every other path: a raw UPDATE, a future service, a repair
-- script.
--
-- Covers UPDATE and DELETE, deliberately not INSERT: two legitimate flows create
-- an invoice already in ISSUED and then insert its lines in the same transaction
-- (`invoices-write.service.ts` when the caller asks for ISSUED, and
-- `so-lifecycle.service.ts` invoicing a sales order), and a row trigger cannot
-- tell those from a line appended later.
--
-- The DELETE branch stands aside when the parent invoice is already gone. The
-- FK is ON DELETE CASCADE, so deleting an invoice — or the organization above it
-- — reaches these rows as a referential action after the parent row has gone;
-- refusing there would make an issued invoice permanently undeletable and take
-- org deletion and DPDP erasure down with it.
--
-- Safe to run online: CREATE OR REPLACE FUNCTION + CREATE TRIGGER, no table
-- rewrite. Existing non-draft invoices are protected on the next write attempt.
-- =============================================================================

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_invoice_item_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_id integer;
  parent_status text;
BEGIN
  parent_id := OLD.invoice_id;

  SELECT status INTO parent_status FROM invoices WHERE id = parent_id;

  IF NOT FOUND THEN
    RETURN OLD;
  END IF;

  IF parent_status = 'DRAFT' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'UPDATE' AND NOT (
    OLD.invoice_id   IS DISTINCT FROM NEW.invoice_id   OR
    OLD.description  IS DISTINCT FROM NEW.description  OR
    OLD.hsn_sac_code IS DISTINCT FROM NEW.hsn_sac_code OR
    OLD.quantity     IS DISTINCT FROM NEW.quantity     OR
    OLD.rate         IS DISTINCT FROM NEW.rate         OR
    OLD.gst_rate     IS DISTINCT FROM NEW.gst_rate     OR
    OLD.amount       IS DISTINCT FROM NEW.amount       OR
    OLD.line_order   IS DISTINCT FROM NEW.line_order
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'line items of a non-draft invoice are immutable (invoice %, status %); issue a credit note for corrections',
    parent_id, parent_status
  USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_invoice_item_immutability ON invoice_items;
--> statement-breakpoint

CREATE TRIGGER trg_invoice_item_immutability
  BEFORE UPDATE OR DELETE ON invoice_items
  FOR EACH ROW
  EXECUTE FUNCTION enforce_invoice_item_immutability();
