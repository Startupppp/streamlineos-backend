-- 0995 DOWN — restores the four single-column constraints and returns the composite
-- twins to NO ACTION, which is the shape they carried before this migration.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE credit_note_items DROP CONSTRAINT IF EXISTS fk_credit_note_items_credit_note_id_org;
--> statement-breakpoint

ALTER TABLE credit_note_items
  ADD CONSTRAINT fk_credit_note_items_credit_note_id_org
  FOREIGN KEY (org_id, credit_note_id) REFERENCES credit_notes (org_id, id) NOT VALID;
--> statement-breakpoint

ALTER TABLE credit_note_items
  ADD CONSTRAINT credit_note_items_credit_note_id_credit_notes_id_fk
  FOREIGN KEY (credit_note_id) REFERENCES credit_notes (id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE vendor_credit_items DROP CONSTRAINT IF EXISTS fk_vendor_credit_items_vendor_credit_id_org;
--> statement-breakpoint

ALTER TABLE vendor_credit_items
  ADD CONSTRAINT fk_vendor_credit_items_vendor_credit_id_org
  FOREIGN KEY (org_id, vendor_credit_id) REFERENCES vendor_credits (org_id, id) NOT VALID;
--> statement-breakpoint

ALTER TABLE vendor_credit_items
  ADD CONSTRAINT vendor_credit_items_vendor_credit_id_vendor_credits_id_fk
  FOREIGN KEY (vendor_credit_id) REFERENCES vendor_credits (id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE credit_notes DROP CONSTRAINT IF EXISTS fk_credit_notes_invoice_id_org;
--> statement-breakpoint

ALTER TABLE credit_notes
  ADD CONSTRAINT fk_credit_notes_invoice_id_org
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) NOT VALID;
--> statement-breakpoint

ALTER TABLE credit_notes
  ADD CONSTRAINT credit_notes_invoice_id_invoices_id_fk
  FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE vendor_credits DROP CONSTRAINT IF EXISTS fk_vendor_credits_bill_id_org;
--> statement-breakpoint

ALTER TABLE vendor_credits
  ADD CONSTRAINT fk_vendor_credits_bill_id_org
  FOREIGN KEY (org_id, bill_id) REFERENCES purchase_bills (org_id, id) NOT VALID;
--> statement-breakpoint

ALTER TABLE vendor_credits
  ADD CONSTRAINT vendor_credits_bill_id_purchase_bills_id_fk
  FOREIGN KEY (bill_id) REFERENCES purchase_bills (id) ON DELETE SET NULL NOT VALID;
