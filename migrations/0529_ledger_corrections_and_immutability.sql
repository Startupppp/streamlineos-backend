-- A2 (1, 3) — a correction points at what it corrects, and a posted movement
-- stops being editable.
--
-- Two separate defects, fixed together because they are the same idea: an
-- inventory ledger is a record of things that happened, and a record of things
-- that happened is append-only. You do not edit history; you post a movement
-- that says history was wrong.

-- ---------------------------------------------------------------------------
-- 1. The correction link.
--
-- `reverseInTx` already posts a compensating movement, but the compensating row
-- and the row it compensates were related only by a `reference_type = 'reversal'`
-- and a `reference_id` holding the original id as text. That is a convention,
-- not a constraint: nothing stopped a reversal naming a transaction in another
-- tenant, or naming one that does not exist, and no index made "has this been
-- reversed?" answerable without a text comparison.
-- ---------------------------------------------------------------------------
ALTER TABLE inv_stock_transactions
  ADD COLUMN IF NOT EXISTS correction_of_transaction_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_inv_stock_transactions_correction_of_org'
  ) THEN
    -- Composite, so a correction can only ever point inside its own tenant.
    -- (org_id, id) is already unique via uniq_inv_stock_transactions_org_id.
    ALTER TABLE inv_stock_transactions
      ADD CONSTRAINT fk_inv_stock_transactions_correction_of_org
      FOREIGN KEY (org_id, correction_of_transaction_id)
      REFERENCES inv_stock_transactions (org_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- A posted movement may be corrected once. Reversing the same movement twice
-- unwinds it twice, and the second unwind is stock that never existed. The
-- service checks first for a legible error; this index is what makes the check
-- true under two concurrent reversals, where a check alone always loses.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_stock_transactions_correction_of
  ON inv_stock_transactions (org_id, correction_of_transaction_id)
  WHERE correction_of_transaction_id IS NOT NULL;

-- Answering "which movements are corrections" without scanning.
CREATE INDEX IF NOT EXISTS idx_inv_stock_transactions_correction_source
  ON inv_stock_transactions (org_id, id)
  WHERE correction_of_transaction_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Immutability of a posted movement.
--
-- The costing path used to INSERT the ledger row and then UPDATE its unit_cost
-- and total_cost a moment later. That worked, but it left the table's facts
-- writable, and a table whose facts are writable will eventually be written to:
-- the arithmetic CHECK (after = before + change) is enforced per row, so an
-- UPDATE that moved all three consistently would satisfy it and silently
-- restate a closed period.
--
-- Annotations stay editable — notes, reason and metadata describe the movement
-- rather than being it. Everything else is a fact.
--
-- Deliberately BEFORE UPDATE only, not DELETE: organizations cascade-delete
-- into this table, and a DELETE guard would make deleting a tenant impossible.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION inv_stock_transactions_no_restatement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  changed text;
BEGIN
  changed := CASE
    WHEN NEW.org_id                       IS DISTINCT FROM OLD.org_id                       THEN 'org_id'
    WHEN NEW.product_variant_id           IS DISTINCT FROM OLD.product_variant_id           THEN 'product_variant_id'
    WHEN NEW.location_id                  IS DISTINCT FROM OLD.location_id                  THEN 'location_id'
    WHEN NEW.transaction_type             IS DISTINCT FROM OLD.transaction_type             THEN 'transaction_type'
    WHEN NEW.quantity_bucket              IS DISTINCT FROM OLD.quantity_bucket              THEN 'quantity_bucket'
    -- numeric comparison, so '5.0000' and '5.00' are the same quantity
    WHEN NEW.quantity_change              IS DISTINCT FROM OLD.quantity_change              THEN 'quantity_change'
    WHEN NEW.quantity_before              IS DISTINCT FROM OLD.quantity_before              THEN 'quantity_before'
    WHEN NEW.quantity_after               IS DISTINCT FROM OLD.quantity_after               THEN 'quantity_after'
    WHEN NEW.lot_id                       IS DISTINCT FROM OLD.lot_id                       THEN 'lot_id'
    WHEN NEW.serial_id                    IS DISTINCT FROM OLD.serial_id                    THEN 'serial_id'
    WHEN NEW.unit_cost                    IS DISTINCT FROM OLD.unit_cost                    THEN 'unit_cost'
    WHEN NEW.total_cost                   IS DISTINCT FROM OLD.total_cost                   THEN 'total_cost'
    WHEN NEW.posting_date                 IS DISTINCT FROM OLD.posting_date                 THEN 'posting_date'
    WHEN NEW.idempotency_key              IS DISTINCT FROM OLD.idempotency_key              THEN 'idempotency_key'
    WHEN NEW.reference_type               IS DISTINCT FROM OLD.reference_type               THEN 'reference_type'
    WHEN NEW.reference_id                 IS DISTINCT FROM OLD.reference_id                 THEN 'reference_id'
    WHEN NEW.correction_of_transaction_id IS DISTINCT FROM OLD.correction_of_transaction_id THEN 'correction_of_transaction_id'
    WHEN NEW.created_by                   IS DISTINCT FROM OLD.created_by                   THEN 'created_by'
    WHEN NEW.created_at                   IS DISTINCT FROM OLD.created_at                   THEN 'created_at'
    ELSE NULL
  END;

  IF changed IS NOT NULL THEN
    RAISE EXCEPTION
      'inv_stock_transactions is append-only: % cannot be changed on posted movement %',
      changed, OLD.id
      USING ERRCODE = '23514',
            HINT = 'Post a compensating movement with correction_of_transaction_id instead of editing this one.';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_inv_stock_transactions_no_restatement ON inv_stock_transactions;
CREATE TRIGGER trg_inv_stock_transactions_no_restatement
  BEFORE UPDATE ON inv_stock_transactions
  FOR EACH ROW
  EXECUTE FUNCTION inv_stock_transactions_no_restatement();
