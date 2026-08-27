-- 0565 — c26-05: an issued billing snapshot cannot change
-- =============================================================================
-- Ticket: c26-05 (invoices snapshot tax and currency immutably)
--
-- c26-05 previously cited migration 0492 as the enforcement for this. That is
-- wrong: 0492's trg_invoice_immutability is on `invoices`, the organisation's own
-- customer invoicing (accounting). It never touches billing_invoice_snapshots, so
-- until this migration ran, every field of an ISSUED platform invoice was
-- overwritable. This is the missing half.
--
-- What a customer was charged cannot change after the fact. A BEFORE UPDATE
-- trigger rejects any attempt to mutate the snapshotted fields of a non-DRAFT
-- row. Status transitions (ISSUED -> PAID -> VOID) and their timestamps stay
-- writable, because moving a document through its lifecycle is not changing what
-- it says. Corrections go through billing_credit_notes.
--
-- Guarded on billing_invoice_snapshots: every money column, currency, tax
-- behaviour, FX rate/source/capture time, rounding rule, invoice number, both
-- parties' identity, addresses and tax registrations, place of supply and the
-- billed period.
-- Writable after issue: status, paid_at, voided_at, due_at.
--
-- Line snapshots and credit-note lines are guarded on UPDATE only, never on
-- DELETE: an ON DELETE CASCADE from `organizations` (tenant erasure) must still
-- be able to remove them. An issued snapshot is protected from deletion instead
-- by billing_credit_notes.original_snapshot_id, which is ON DELETE RESTRICT.
--
-- Safe to run online: CREATE OR REPLACE FUNCTION + CREATE TRIGGER; no rewrite.
-- =============================================================================

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_billing_invoice_snapshot_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND (
    OLD.invoice_number     IS DISTINCT FROM NEW.invoice_number     OR
    OLD.currency           IS DISTINCT FROM NEW.currency           OR
    OLD.tax_behavior       IS DISTINCT FROM NEW.tax_behavior       OR
    OLD.subtotal_minor     IS DISTINCT FROM NEW.subtotal_minor     OR
    OLD.tax_amount_minor   IS DISTINCT FROM NEW.tax_amount_minor   OR
    OLD.total_minor        IS DISTINCT FROM NEW.total_minor        OR
    OLD.rounding_rule      IS DISTINCT FROM NEW.rounding_rule      OR
    OLD.fx_rate_micro      IS DISTINCT FROM NEW.fx_rate_micro      OR
    OLD.fx_rate_source     IS DISTINCT FROM NEW.fx_rate_source     OR
    OLD.fx_rate_captured_at IS DISTINCT FROM NEW.fx_rate_captured_at OR
    OLD.seller_name        IS DISTINCT FROM NEW.seller_name        OR
    OLD.seller_address     IS DISTINCT FROM NEW.seller_address     OR
    OLD.seller_tax_ids     IS DISTINCT FROM NEW.seller_tax_ids     OR
    OLD.buyer_name         IS DISTINCT FROM NEW.buyer_name         OR
    OLD.buyer_address      IS DISTINCT FROM NEW.buyer_address      OR
    OLD.buyer_tax_ids      IS DISTINCT FROM NEW.buyer_tax_ids      OR
    OLD.place_of_supply    IS DISTINCT FROM NEW.place_of_supply    OR
    OLD.period_start       IS DISTINCT FROM NEW.period_start       OR
    OLD.period_end         IS DISTINCT FROM NEW.period_end         OR
    OLD.issued_at          IS DISTINCT FROM NEW.issued_at          OR
    OLD.org_id             IS DISTINCT FROM NEW.org_id             OR
    OLD.subscription_id    IS DISTINCT FROM NEW.subscription_id
  ) THEN
    RAISE EXCEPTION
      'an issued invoice snapshot is immutable (status: %); issue a credit note for corrections',
      OLD.status
    USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_billing_invoice_snapshot_immutability ON billing_invoice_snapshots;
--> statement-breakpoint

CREATE TRIGGER trg_billing_invoice_snapshot_immutability
  BEFORE UPDATE ON billing_invoice_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION enforce_billing_invoice_snapshot_immutability();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_billing_invoice_line_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status
  FROM billing_invoice_snapshots
  WHERE id = OLD.snapshot_id;

  IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION
      'a line of an issued invoice snapshot is immutable (invoice status: %); issue a credit note for corrections',
      parent_status
    USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_billing_invoice_line_immutability ON billing_invoice_line_snapshots;
--> statement-breakpoint

CREATE TRIGGER trg_billing_invoice_line_immutability
  BEFORE UPDATE ON billing_invoice_line_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION enforce_billing_invoice_line_immutability();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_billing_credit_note_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND (
    OLD.note_number          IS DISTINCT FROM NEW.note_number          OR
    OLD.note_type            IS DISTINCT FROM NEW.note_type            OR
    OLD.currency             IS DISTINCT FROM NEW.currency             OR
    OLD.total_minor          IS DISTINCT FROM NEW.total_minor          OR
    OLD.reason               IS DISTINCT FROM NEW.reason               OR
    OLD.original_snapshot_id IS DISTINCT FROM NEW.original_snapshot_id OR
    OLD.issued_at            IS DISTINCT FROM NEW.issued_at            OR
    OLD.org_id               IS DISTINCT FROM NEW.org_id
  ) THEN
    RAISE EXCEPTION
      'an issued credit note is immutable (status: %)',
      OLD.status
    USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_billing_credit_note_immutability ON billing_credit_notes;
--> statement-breakpoint

CREATE TRIGGER trg_billing_credit_note_immutability
  BEFORE UPDATE ON billing_credit_notes
  FOR EACH ROW
  EXECUTE FUNCTION enforce_billing_credit_note_immutability();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_billing_credit_note_line_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status
  FROM billing_credit_notes
  WHERE id = OLD.credit_note_id;

  IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION
      'a line of an issued credit note is immutable (note status: %)',
      parent_status
    USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_billing_credit_note_line_immutability ON billing_credit_note_lines;
--> statement-breakpoint

CREATE TRIGGER trg_billing_credit_note_line_immutability
  BEFORE UPDATE ON billing_credit_note_lines
  FOR EACH ROW
  EXECUTE FUNCTION enforce_billing_credit_note_line_immutability();
