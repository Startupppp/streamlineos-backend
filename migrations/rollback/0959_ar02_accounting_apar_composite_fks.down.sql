-- 0959 DOWN — drops all AP/AR composite tenant FK constraints.
--
-- @reopens-a-defect: the composite tenant FKs on AP/AR tables are removed, so rows in
-- ap_allocations, ap_document_lines, ap_documents, ap_payments, ap_withholding,
-- ar_allocations, ar_document_lines, ar_documents, and ar_receipts can reference
-- mismatched org_id pairs without the DB raising an error. Cross-tenant referential
-- integrity on the AP/AR sub-tables reverts to application-layer enforcement only.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE ap_allocations DROP CONSTRAINT IF EXISTS fk_ap_allocations_org_debit_note;
ALTER TABLE ap_allocations DROP CONSTRAINT IF EXISTS fk_ap_allocations_org_document;
ALTER TABLE ap_allocations DROP CONSTRAINT IF EXISTS fk_ap_allocations_org_payment;
ALTER TABLE ap_allocations DROP CONSTRAINT IF EXISTS fk_ap_allocations_org_book;
ALTER TABLE ap_document_lines DROP CONSTRAINT IF EXISTS fk_ap_document_lines_org_document;
ALTER TABLE ap_document_lines DROP CONSTRAINT IF EXISTS fk_ap_document_lines_org_expense_account;
ALTER TABLE ap_documents DROP CONSTRAINT IF EXISTS fk_ap_documents_org_original_document;
ALTER TABLE ap_documents DROP CONSTRAINT IF EXISTS fk_ap_documents_org_book;
ALTER TABLE ap_documents DROP CONSTRAINT IF EXISTS fk_ap_documents_org_posted_journal;
ALTER TABLE ap_documents DROP CONSTRAINT IF EXISTS fk_ap_documents_org_party;
ALTER TABLE ap_payments DROP CONSTRAINT IF EXISTS fk_ap_payments_org_payment_account;
ALTER TABLE ap_payments DROP CONSTRAINT IF EXISTS fk_ap_payments_org_book;
ALTER TABLE ap_payments DROP CONSTRAINT IF EXISTS fk_ap_payments_org_posted_journal;
ALTER TABLE ap_payments DROP CONSTRAINT IF EXISTS fk_ap_payments_org_reversal_journal;
ALTER TABLE ap_payments DROP CONSTRAINT IF EXISTS fk_ap_payments_org_party;
ALTER TABLE ap_withholding DROP CONSTRAINT IF EXISTS fk_ap_withholding_org_document;
ALTER TABLE ap_withholding DROP CONSTRAINT IF EXISTS fk_ap_withholding_org_payment;
ALTER TABLE ap_withholding DROP CONSTRAINT IF EXISTS fk_ap_withholding_org_gl_account;
ALTER TABLE ap_withholding DROP CONSTRAINT IF EXISTS fk_ap_withholding_org_book;
ALTER TABLE ar_allocations DROP CONSTRAINT IF EXISTS fk_ar_allocations_org_credit_note;
ALTER TABLE ar_allocations DROP CONSTRAINT IF EXISTS fk_ar_allocations_org_document;
ALTER TABLE ar_allocations DROP CONSTRAINT IF EXISTS fk_ar_allocations_org_receipt;
ALTER TABLE ar_allocations DROP CONSTRAINT IF EXISTS fk_ar_allocations_org_book;
ALTER TABLE ar_document_lines DROP CONSTRAINT IF EXISTS fk_ar_document_lines_org_document;
ALTER TABLE ar_document_lines DROP CONSTRAINT IF EXISTS fk_ar_document_lines_org_income_account;
ALTER TABLE ar_documents DROP CONSTRAINT IF EXISTS fk_ar_documents_org_original_document;
ALTER TABLE ar_documents DROP CONSTRAINT IF EXISTS fk_ar_documents_org_book;
ALTER TABLE ar_documents DROP CONSTRAINT IF EXISTS fk_ar_documents_org_posted_journal;
ALTER TABLE ar_documents DROP CONSTRAINT IF EXISTS fk_ar_documents_org_party;
ALTER TABLE ar_receipts DROP CONSTRAINT IF EXISTS fk_ar_receipts_org_deposit_account;
ALTER TABLE ar_receipts DROP CONSTRAINT IF EXISTS fk_ar_receipts_org_book;
ALTER TABLE ar_receipts DROP CONSTRAINT IF EXISTS fk_ar_receipts_org_posted_journal;
ALTER TABLE ar_receipts DROP CONSTRAINT IF EXISTS fk_ar_receipts_org_reversal_journal;
ALTER TABLE ar_receipts DROP CONSTRAINT IF EXISTS fk_ar_receipts_org_party;
