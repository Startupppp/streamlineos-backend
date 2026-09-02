-- AR-02: composite tenant FKs — AP/AR tables
-- Covers: ap_allocations, ap_document_lines, ap_documents, ap_payments,
--         ap_withholding, ar_allocations, ar_document_lines, ar_documents, ar_receipts

SET lock_timeout = DEFAULT;

ALTER TABLE ap_allocations
  ADD CONSTRAINT fk_ap_allocations_org_debit_note
  FOREIGN KEY (org_id, debit_note_id)
  REFERENCES ap_documents (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_allocations VALIDATE CONSTRAINT fk_ap_allocations_org_debit_note;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ap_allocations
  ADD CONSTRAINT fk_ap_allocations_org_document
  FOREIGN KEY (org_id, document_id)
  REFERENCES ap_documents (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_allocations VALIDATE CONSTRAINT fk_ap_allocations_org_document;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ap_allocations
  ADD CONSTRAINT fk_ap_allocations_org_payment
  FOREIGN KEY (org_id, payment_id)
  REFERENCES ap_payments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_allocations VALIDATE CONSTRAINT fk_ap_allocations_org_payment;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ap_allocations
  ADD CONSTRAINT fk_ap_allocations_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_allocations VALIDATE CONSTRAINT fk_ap_allocations_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ap_document_lines
  ADD CONSTRAINT fk_ap_document_lines_org_document
  FOREIGN KEY (org_id, document_id)
  REFERENCES ap_documents (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_document_lines VALIDATE CONSTRAINT fk_ap_document_lines_org_document;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ap_document_lines
  ADD CONSTRAINT fk_ap_document_lines_org_expense_account
  FOREIGN KEY (org_id, expense_account_id)
  REFERENCES gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_document_lines VALIDATE CONSTRAINT fk_ap_document_lines_org_expense_account;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ap_documents
  ADD CONSTRAINT fk_ap_documents_org_original_document
  FOREIGN KEY (org_id, original_document_id)
  REFERENCES ap_documents (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_documents VALIDATE CONSTRAINT fk_ap_documents_org_original_document;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ap_documents
  ADD CONSTRAINT fk_ap_documents_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_documents VALIDATE CONSTRAINT fk_ap_documents_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ap_documents
  ADD CONSTRAINT fk_ap_documents_org_posted_journal
  FOREIGN KEY (org_id, posted_journal_id)
  REFERENCES gl_journals (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_documents VALIDATE CONSTRAINT fk_ap_documents_org_posted_journal;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ap_documents
  ADD CONSTRAINT fk_ap_documents_org_party
  FOREIGN KEY (org_id, party_id)
  REFERENCES gl_parties (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_documents VALIDATE CONSTRAINT fk_ap_documents_org_party;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ap_payments
  ADD CONSTRAINT fk_ap_payments_org_payment_account
  FOREIGN KEY (org_id, payment_account_id)
  REFERENCES gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_payments VALIDATE CONSTRAINT fk_ap_payments_org_payment_account;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ap_payments
  ADD CONSTRAINT fk_ap_payments_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_payments VALIDATE CONSTRAINT fk_ap_payments_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ap_payments
  ADD CONSTRAINT fk_ap_payments_org_posted_journal
  FOREIGN KEY (org_id, posted_journal_id)
  REFERENCES gl_journals (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_payments VALIDATE CONSTRAINT fk_ap_payments_org_posted_journal;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ap_payments
  ADD CONSTRAINT fk_ap_payments_org_reversal_journal
  FOREIGN KEY (org_id, reversal_journal_id)
  REFERENCES gl_journals (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_payments VALIDATE CONSTRAINT fk_ap_payments_org_reversal_journal;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ap_payments
  ADD CONSTRAINT fk_ap_payments_org_party
  FOREIGN KEY (org_id, party_id)
  REFERENCES gl_parties (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_payments VALIDATE CONSTRAINT fk_ap_payments_org_party;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ap_withholding
  ADD CONSTRAINT fk_ap_withholding_org_document
  FOREIGN KEY (org_id, document_id)
  REFERENCES ap_documents (org_id, id)
  ON DELETE SET NULL (document_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_withholding VALIDATE CONSTRAINT fk_ap_withholding_org_document;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ap_withholding
  ADD CONSTRAINT fk_ap_withholding_org_payment
  FOREIGN KEY (org_id, payment_id)
  REFERENCES ap_payments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_withholding VALIDATE CONSTRAINT fk_ap_withholding_org_payment;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ap_withholding
  ADD CONSTRAINT fk_ap_withholding_org_gl_account
  FOREIGN KEY (org_id, gl_account_id)
  REFERENCES gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_withholding VALIDATE CONSTRAINT fk_ap_withholding_org_gl_account;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ap_withholding
  ADD CONSTRAINT fk_ap_withholding_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ap_withholding VALIDATE CONSTRAINT fk_ap_withholding_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ar_allocations
  ADD CONSTRAINT fk_ar_allocations_org_credit_note
  FOREIGN KEY (org_id, credit_note_id)
  REFERENCES ar_documents (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ar_allocations VALIDATE CONSTRAINT fk_ar_allocations_org_credit_note;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ar_allocations
  ADD CONSTRAINT fk_ar_allocations_org_document
  FOREIGN KEY (org_id, document_id)
  REFERENCES ar_documents (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ar_allocations VALIDATE CONSTRAINT fk_ar_allocations_org_document;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ar_allocations
  ADD CONSTRAINT fk_ar_allocations_org_receipt
  FOREIGN KEY (org_id, receipt_id)
  REFERENCES ar_receipts (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ar_allocations VALIDATE CONSTRAINT fk_ar_allocations_org_receipt;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ar_allocations
  ADD CONSTRAINT fk_ar_allocations_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ar_allocations VALIDATE CONSTRAINT fk_ar_allocations_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ar_document_lines
  ADD CONSTRAINT fk_ar_document_lines_org_document
  FOREIGN KEY (org_id, document_id)
  REFERENCES ar_documents (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ar_document_lines VALIDATE CONSTRAINT fk_ar_document_lines_org_document;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ar_document_lines
  ADD CONSTRAINT fk_ar_document_lines_org_income_account
  FOREIGN KEY (org_id, income_account_id)
  REFERENCES gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ar_document_lines VALIDATE CONSTRAINT fk_ar_document_lines_org_income_account;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ar_documents
  ADD CONSTRAINT fk_ar_documents_org_original_document
  FOREIGN KEY (org_id, original_document_id)
  REFERENCES ar_documents (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ar_documents VALIDATE CONSTRAINT fk_ar_documents_org_original_document;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ar_documents
  ADD CONSTRAINT fk_ar_documents_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ar_documents VALIDATE CONSTRAINT fk_ar_documents_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ar_documents
  ADD CONSTRAINT fk_ar_documents_org_posted_journal
  FOREIGN KEY (org_id, posted_journal_id)
  REFERENCES gl_journals (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ar_documents VALIDATE CONSTRAINT fk_ar_documents_org_posted_journal;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ar_documents
  ADD CONSTRAINT fk_ar_documents_org_party
  FOREIGN KEY (org_id, party_id)
  REFERENCES gl_parties (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ar_documents VALIDATE CONSTRAINT fk_ar_documents_org_party;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ar_receipts
  ADD CONSTRAINT fk_ar_receipts_org_deposit_account
  FOREIGN KEY (org_id, deposit_account_id)
  REFERENCES gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ar_receipts VALIDATE CONSTRAINT fk_ar_receipts_org_deposit_account;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ar_receipts
  ADD CONSTRAINT fk_ar_receipts_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ar_receipts VALIDATE CONSTRAINT fk_ar_receipts_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ar_receipts
  ADD CONSTRAINT fk_ar_receipts_org_posted_journal
  FOREIGN KEY (org_id, posted_journal_id)
  REFERENCES gl_journals (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ar_receipts VALIDATE CONSTRAINT fk_ar_receipts_org_posted_journal;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ar_receipts
  ADD CONSTRAINT fk_ar_receipts_org_reversal_journal
  FOREIGN KEY (org_id, reversal_journal_id)
  REFERENCES gl_journals (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ar_receipts VALIDATE CONSTRAINT fk_ar_receipts_org_reversal_journal;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE ar_receipts
  ADD CONSTRAINT fk_ar_receipts_org_party
  FOREIGN KEY (org_id, party_id)
  REFERENCES gl_parties (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE ar_receipts VALIDATE CONSTRAINT fk_ar_receipts_org_party;
SET lock_timeout = DEFAULT;
