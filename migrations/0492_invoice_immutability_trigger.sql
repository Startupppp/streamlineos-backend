-- 0492 — invoice immutability: financial fields are locked once an invoice is issued
-- =============================================================================
-- Ticket: c17-07 (an issued invoice cannot change)
--
-- What a customer was charged cannot change after the fact. A BEFORE UPDATE trigger
-- rejects any attempt to mutate financial fields on a non-DRAFT invoice. Status
-- transitions (ISSUED → PAID), administrative fields (notes, due_date, next_reminder_at)
-- and soft-delete markers are still writable. Corrections go through credit notes.
--
-- Financial fields guarded: subtotal, tax_amount, discount, total, currency,
-- cgst_amount, sgst_amount, igst_amount, tax_rate, exchange_rate.
--
-- Safe to run online: CREATE OR REPLACE FUNCTION + CREATE TRIGGER; no table rewrite.
-- Existing invoices with non-DRAFT status will immediately be protected on next
-- UPDATE attempt.
-- =============================================================================

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_invoice_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND (
    OLD.subtotal     IS DISTINCT FROM NEW.subtotal     OR
    OLD.tax_rate     IS DISTINCT FROM NEW.tax_rate     OR
    OLD.tax_amount   IS DISTINCT FROM NEW.tax_amount   OR
    OLD.discount     IS DISTINCT FROM NEW.discount     OR
    OLD.total        IS DISTINCT FROM NEW.total        OR
    OLD.currency     IS DISTINCT FROM NEW.currency     OR
    OLD.cgst_amount  IS DISTINCT FROM NEW.cgst_amount  OR
    OLD.sgst_amount  IS DISTINCT FROM NEW.sgst_amount  OR
    OLD.igst_amount  IS DISTINCT FROM NEW.igst_amount  OR
    OLD.exchange_rate IS DISTINCT FROM NEW.exchange_rate
  ) THEN
    RAISE EXCEPTION
      'financial fields of a non-draft invoice are immutable (status: %); issue a credit note for corrections',
      OLD.status
    USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_invoice_immutability ON invoices;
--> statement-breakpoint

CREATE TRIGGER trg_invoice_immutability
  BEFORE UPDATE ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION enforce_invoice_immutability();
