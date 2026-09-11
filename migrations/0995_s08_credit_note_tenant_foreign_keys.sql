-- Four foreign keys between two tenant-owned tables carried no tenant column.
-- check:tenant-relationships could not see them: credit_notes and vendor_credits
-- were both listed in the gate's CRM_TABLE_NAMES exclusion despite being declared
-- in db/schema/accounting/finance-ar-ap.ts, so the gate reported zero actionable
-- rows in both modes. Ticket 03 removed the exclusion and the four appeared.
--
--   credit_note_items (credit_note_id)   -> credit_notes   ON DELETE CASCADE
--   vendor_credit_items (vendor_credit_id) -> vendor_credits ON DELETE CASCADE
--   credit_notes (invoice_id)            -> invoices        ON DELETE SET NULL
--   vendor_credits (bill_id)             -> purchase_bills  ON DELETE SET NULL
--
-- Each already has a tenant-safe composite twin, so a line in one organisation can
-- reference a header in another and the single-column CASCADE lets a delete in one
-- organisation reach a child row pinned to a different one. The repair is to drop
-- the single-column constraint and move its referential action onto the composite,
-- which is where the tenant conjunct lives; dropping it without moving the action
-- would silently turn a cascading delete into a 23503.
--
-- The two SET NULL constraints get an explicit column list. A composite SET NULL
-- with no list writes NULL into every referencing column, and org_id is NOT NULL on
-- both tables, so the parent delete would raise 23502 instead of clearing the
-- pointer -- the exact defect 0770 swept and 0992 repaired. 0992 re-derives its
-- lists at run time, but it runs before this file, so the assertion at the end of
-- this migration is what keeps these four honest.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE credit_note_items
  DROP CONSTRAINT IF EXISTS credit_note_items_credit_note_id_credit_notes_id_fk;
--> statement-breakpoint

ALTER TABLE credit_note_items
  DROP CONSTRAINT IF EXISTS fk_credit_note_items_credit_note_id_org;
--> statement-breakpoint

ALTER TABLE credit_note_items
  ADD CONSTRAINT fk_credit_note_items_credit_note_id_org
  FOREIGN KEY (org_id, credit_note_id)
  REFERENCES credit_notes (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint

ALTER TABLE credit_note_items VALIDATE CONSTRAINT fk_credit_note_items_credit_note_id_org;
--> statement-breakpoint

ALTER TABLE vendor_credit_items
  DROP CONSTRAINT IF EXISTS vendor_credit_items_vendor_credit_id_vendor_credits_id_fk;
--> statement-breakpoint

ALTER TABLE vendor_credit_items
  DROP CONSTRAINT IF EXISTS fk_vendor_credit_items_vendor_credit_id_org;
--> statement-breakpoint

ALTER TABLE vendor_credit_items
  ADD CONSTRAINT fk_vendor_credit_items_vendor_credit_id_org
  FOREIGN KEY (org_id, vendor_credit_id)
  REFERENCES vendor_credits (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint

ALTER TABLE vendor_credit_items VALIDATE CONSTRAINT fk_vendor_credit_items_vendor_credit_id_org;
--> statement-breakpoint

ALTER TABLE credit_notes
  DROP CONSTRAINT IF EXISTS credit_notes_invoice_id_invoices_id_fk;
--> statement-breakpoint

ALTER TABLE credit_notes
  DROP CONSTRAINT IF EXISTS fk_credit_notes_invoice_id_org;
--> statement-breakpoint

ALTER TABLE credit_notes
  ADD CONSTRAINT fk_credit_notes_invoice_id_org
  FOREIGN KEY (org_id, invoice_id)
  REFERENCES invoices (org_id, id)
  ON DELETE SET NULL (invoice_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE credit_notes VALIDATE CONSTRAINT fk_credit_notes_invoice_id_org;
--> statement-breakpoint

ALTER TABLE vendor_credits
  DROP CONSTRAINT IF EXISTS vendor_credits_bill_id_purchase_bills_id_fk;
--> statement-breakpoint

ALTER TABLE vendor_credits
  DROP CONSTRAINT IF EXISTS fk_vendor_credits_bill_id_org;
--> statement-breakpoint

ALTER TABLE vendor_credits
  ADD CONSTRAINT fk_vendor_credits_bill_id_org
  FOREIGN KEY (org_id, bill_id)
  REFERENCES purchase_bills (org_id, id)
  ON DELETE SET NULL (bill_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE vendor_credits VALIDATE CONSTRAINT fk_vendor_credits_bill_id_org;
--> statement-breakpoint

DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(rel.relname || '.' || con.conname, ', ' ORDER BY con.conname)
    INTO offenders
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE con.conname IN (
           'fk_credit_note_items_credit_note_id_org',
           'fk_vendor_credit_items_vendor_credit_id_org',
           'fk_credit_notes_invoice_id_org',
           'fk_vendor_credits_bill_id_org')
     AND (
       con.convalidated IS NOT TRUE
       OR EXISTS (
         SELECT 1
           FROM unnest(COALESCE(con.confdelsetcols, ARRAY[]::smallint[])) z(attnum)
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = z.attnum
          WHERE a.attnotnull)
       OR (con.confdeltype = 'n' AND con.confdelsetcols IS NULL));

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'tenant foreign keys left in an unusable shape: %', offenders;
  END IF;

  SELECT string_agg(rel.relname || '.' || con.conname, ', ' ORDER BY con.conname)
    INTO offenders
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE con.conname IN (
           'credit_note_items_credit_note_id_credit_notes_id_fk',
           'vendor_credit_items_vendor_credit_id_vendor_credits_id_fk',
           'credit_notes_invoice_id_invoices_id_fk',
           'vendor_credits_bill_id_purchase_bills_id_fk');

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'single-column tenant foreign keys survived the drop: %', offenders;
  END IF;
END $$;
