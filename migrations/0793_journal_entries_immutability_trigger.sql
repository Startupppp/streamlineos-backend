-- 0793 — journal_entries and journal_lines BEFORE UPDATE immutability
-- =============================================================================
-- §28.11 Item C: posted financial records are immutable at the database layer.
--
-- journal_entries already have a service-level assertEntryNotPosted guard in
-- FinancePostingService, but that guard is bypassed by a raw SQL UPDATE. This
-- migration closes the same gap that 0492 closed for invoices and 0565 closed
-- for billing_invoice_snapshots.
--
-- What a POSTED journal entry records cannot change after posting. Reversals are
-- performed by creating a new entry with reversed_entry_id pointing to the
-- original and setting the original's status to VOID — never by overwriting
-- fields of the posted entry.
--
-- Guarded on journal_entries when status = 'POSTED':
--   entry_number, entry_date, posting_date, currency, source_type, source_id,
--   source_event, created_by, org_id.
--   Status from POSTED may only transition to VOID.
-- When status = 'VOID': all the above fields plus status itself are locked.
-- Writable after posting: reversed_entry_id, approved_by, approved_at,
--   posted_by, posted_at, period_id, description, updated_at.
--
-- Guarded on journal_lines: debit, credit, account_id, entry_id, org_id when
-- the parent journal_entries.status is POSTED or VOID. DELETE (e.g. ON DELETE
-- CASCADE from organizations on tenant erasure) is not blocked — the trigger
-- is BEFORE UPDATE only.
--
-- Safe to run online: function + trigger creation only, no table rewrite.
-- SET lock_timeout prevents an unacknowledged lock from queuing behind
-- a long-running read.
-- =============================================================================

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_journal_entry_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'VOID' AND (
    OLD.entry_number  IS DISTINCT FROM NEW.entry_number  OR
    OLD.entry_date    IS DISTINCT FROM NEW.entry_date    OR
    OLD.posting_date  IS DISTINCT FROM NEW.posting_date  OR
    OLD.currency      IS DISTINCT FROM NEW.currency      OR
    OLD.source_type   IS DISTINCT FROM NEW.source_type   OR
    OLD.source_id     IS DISTINCT FROM NEW.source_id     OR
    OLD.source_event  IS DISTINCT FROM NEW.source_event  OR
    OLD.created_by    IS DISTINCT FROM NEW.created_by    OR
    OLD.org_id        IS DISTINCT FROM NEW.org_id        OR
    OLD.status        IS DISTINCT FROM NEW.status
  ) THEN
    RAISE EXCEPTION
      'a VOID journal entry is fully immutable (entry: %)',
      OLD.entry_number
    USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'POSTED' AND (
    OLD.entry_number  IS DISTINCT FROM NEW.entry_number  OR
    OLD.entry_date    IS DISTINCT FROM NEW.entry_date    OR
    OLD.posting_date  IS DISTINCT FROM NEW.posting_date  OR
    OLD.currency      IS DISTINCT FROM NEW.currency      OR
    OLD.source_type   IS DISTINCT FROM NEW.source_type   OR
    OLD.source_id     IS DISTINCT FROM NEW.source_id     OR
    OLD.source_event  IS DISTINCT FROM NEW.source_event  OR
    OLD.created_by    IS DISTINCT FROM NEW.created_by    OR
    OLD.org_id        IS DISTINCT FROM NEW.org_id        OR
    (OLD.status IS DISTINCT FROM NEW.status AND NEW.status <> 'VOID')
  ) THEN
    RAISE EXCEPTION
      'a POSTED journal entry is immutable (entry: %); mark VOID and create a reversal entry instead',
      OLD.entry_number
    USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_journal_entry_immutability ON journal_entries;
--> statement-breakpoint

CREATE TRIGGER trg_journal_entry_immutability
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION enforce_journal_entry_immutability();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_journal_line_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status
  FROM journal_entries
  WHERE id = OLD.entry_id;

  IF parent_status IN ('POSTED', 'VOID') AND (
    OLD.debit      IS DISTINCT FROM NEW.debit      OR
    OLD.credit     IS DISTINCT FROM NEW.credit     OR
    OLD.account_id IS DISTINCT FROM NEW.account_id OR
    OLD.org_id     IS DISTINCT FROM NEW.org_id     OR
    OLD.entry_id   IS DISTINCT FROM NEW.entry_id
  ) THEN
    RAISE EXCEPTION
      'lines of a % journal entry are immutable (entry_id: %); create a reversal entry instead',
      parent_status, OLD.entry_id
    USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_journal_line_immutability ON journal_lines;
--> statement-breakpoint

CREATE TRIGGER trg_journal_line_immutability
  BEFORE UPDATE ON journal_lines
  FOR EACH ROW
  EXECUTE FUNCTION enforce_journal_line_immutability();
