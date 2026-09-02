-- AR-02: composite tenant FKs — Bank/Tax/Acc tables
-- Covers: bank_matches, bank_profiles, bank_statement_lines, bank_statements,
--         tax_codes, tax_document_lines, tax_gl_map, tax_rates, tax_registrations,
--         acc_asset_categories, acc_depreciation_runs, acc_depreciation_schedules,
--         acc_fixed_assets, acc_system_account_map, acc_tax_codes, acc_tax_payments

SET lock_timeout = DEFAULT;

ALTER TABLE bank_matches
  ADD CONSTRAINT fk_bank_matches_org_payment
  FOREIGN KEY (org_id, payment_id)
  REFERENCES ap_payments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE bank_matches VALIDATE CONSTRAINT fk_bank_matches_org_payment;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE bank_matches
  ADD CONSTRAINT fk_bank_matches_org_receipt
  FOREIGN KEY (org_id, receipt_id)
  REFERENCES ar_receipts (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE bank_matches VALIDATE CONSTRAINT fk_bank_matches_org_receipt;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE bank_matches
  ADD CONSTRAINT fk_bank_matches_org_statement_line
  FOREIGN KEY (org_id, statement_line_id)
  REFERENCES bank_statement_lines (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE bank_matches VALIDATE CONSTRAINT fk_bank_matches_org_statement_line;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE bank_matches
  ADD CONSTRAINT fk_bank_matches_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE bank_matches VALIDATE CONSTRAINT fk_bank_matches_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE bank_matches
  ADD CONSTRAINT fk_bank_matches_org_journal
  FOREIGN KEY (org_id, journal_id)
  REFERENCES gl_journals (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE bank_matches VALIDATE CONSTRAINT fk_bank_matches_org_journal;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE bank_profiles
  ADD CONSTRAINT fk_bank_profiles_org_account
  FOREIGN KEY (org_id, account_id)
  REFERENCES gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE bank_profiles VALIDATE CONSTRAINT fk_bank_profiles_org_account;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE bank_profiles
  ADD CONSTRAINT fk_bank_profiles_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE bank_profiles VALIDATE CONSTRAINT fk_bank_profiles_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE bank_statement_lines
  ADD CONSTRAINT fk_bank_statement_lines_org_statement
  FOREIGN KEY (org_id, statement_id)
  REFERENCES bank_statements (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE bank_statement_lines VALIDATE CONSTRAINT fk_bank_statement_lines_org_statement;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE bank_statements
  ADD CONSTRAINT fk_bank_statements_org_bank_profile
  FOREIGN KEY (org_id, bank_profile_id)
  REFERENCES bank_profiles (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE bank_statements VALIDATE CONSTRAINT fk_bank_statements_org_bank_profile;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE bank_statements
  ADD CONSTRAINT fk_bank_statements_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE bank_statements VALIDATE CONSTRAINT fk_bank_statements_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE tax_codes
  ADD CONSTRAINT fk_tax_codes_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE tax_codes VALIDATE CONSTRAINT fk_tax_codes_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE tax_document_lines
  ADD CONSTRAINT fk_tax_document_lines_org_gl_account
  FOREIGN KEY (org_id, gl_account_id)
  REFERENCES gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE tax_document_lines VALIDATE CONSTRAINT fk_tax_document_lines_org_gl_account;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE tax_document_lines
  ADD CONSTRAINT fk_tax_document_lines_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE tax_document_lines VALIDATE CONSTRAINT fk_tax_document_lines_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE tax_document_lines
  ADD CONSTRAINT fk_tax_document_lines_org_tax_code
  FOREIGN KEY (org_id, tax_code_id)
  REFERENCES tax_codes (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE tax_document_lines VALIDATE CONSTRAINT fk_tax_document_lines_org_tax_code;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE tax_gl_map
  ADD CONSTRAINT fk_tax_gl_map_org_account
  FOREIGN KEY (org_id, account_id)
  REFERENCES gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE tax_gl_map VALIDATE CONSTRAINT fk_tax_gl_map_org_account;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE tax_gl_map
  ADD CONSTRAINT fk_tax_gl_map_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE tax_gl_map VALIDATE CONSTRAINT fk_tax_gl_map_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE tax_rates
  ADD CONSTRAINT fk_tax_rates_org_tax_code
  FOREIGN KEY (org_id, tax_code_id)
  REFERENCES tax_codes (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE tax_rates VALIDATE CONSTRAINT fk_tax_rates_org_tax_code;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE tax_registrations
  ADD CONSTRAINT fk_tax_registrations_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE tax_registrations VALIDATE CONSTRAINT fk_tax_registrations_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE tax_registrations
  ADD CONSTRAINT fk_tax_registrations_org_party
  FOREIGN KEY (org_id, party_id)
  REFERENCES gl_parties (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE tax_registrations VALIDATE CONSTRAINT fk_tax_registrations_org_party;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE acc_asset_categories
  ADD CONSTRAINT fk_acc_asset_categories_org_accum_depr_acct
  FOREIGN KEY (org_id, accumulated_depreciation_account_id)
  REFERENCES ledger_accounts (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE acc_asset_categories VALIDATE CONSTRAINT fk_acc_asset_categories_org_accum_depr_acct;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE acc_asset_categories
  ADD CONSTRAINT fk_acc_asset_categories_org_asset_acct
  FOREIGN KEY (org_id, asset_account_id)
  REFERENCES ledger_accounts (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE acc_asset_categories VALIDATE CONSTRAINT fk_acc_asset_categories_org_asset_acct;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE acc_asset_categories
  ADD CONSTRAINT fk_acc_asset_categories_org_depr_exp_acct
  FOREIGN KEY (org_id, depreciation_expense_account_id)
  REFERENCES ledger_accounts (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE acc_asset_categories VALIDATE CONSTRAINT fk_acc_asset_categories_org_depr_exp_acct;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE acc_depreciation_runs
  ADD CONSTRAINT fk_acc_depreciation_runs_org_journal_entry
  FOREIGN KEY (org_id, journal_entry_id)
  REFERENCES journal_entries (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE acc_depreciation_runs VALIDATE CONSTRAINT fk_acc_depreciation_runs_org_journal_entry;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE acc_depreciation_schedules
  ADD CONSTRAINT fk_acc_depreciation_schedules_org_run
  FOREIGN KEY (org_id, run_id)
  REFERENCES acc_depreciation_runs (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE acc_depreciation_schedules VALIDATE CONSTRAINT fk_acc_depreciation_schedules_org_run;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE acc_depreciation_schedules
  ADD CONSTRAINT fk_acc_depreciation_schedules_org_asset
  FOREIGN KEY (org_id, asset_id)
  REFERENCES acc_fixed_assets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE acc_depreciation_schedules VALIDATE CONSTRAINT fk_acc_depreciation_schedules_org_asset;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE acc_depreciation_schedules
  ADD CONSTRAINT fk_acc_depreciation_schedules_org_journal
  FOREIGN KEY (org_id, journal_entry_id)
  REFERENCES journal_entries (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE acc_depreciation_schedules VALIDATE CONSTRAINT fk_acc_depreciation_schedules_org_journal;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE acc_fixed_assets
  ADD CONSTRAINT fk_acc_fixed_assets_org_category
  FOREIGN KEY (org_id, category_id)
  REFERENCES acc_asset_categories (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE acc_fixed_assets VALIDATE CONSTRAINT fk_acc_fixed_assets_org_category;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE acc_fixed_assets
  ADD CONSTRAINT fk_acc_fixed_assets_org_disposal_journal
  FOREIGN KEY (org_id, disposal_journal_entry_id)
  REFERENCES journal_entries (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE acc_fixed_assets VALIDATE CONSTRAINT fk_acc_fixed_assets_org_disposal_journal;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE acc_fixed_assets
  ADD CONSTRAINT fk_acc_fixed_assets_org_bill
  FOREIGN KEY (org_id, bill_id)
  REFERENCES purchase_bills (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE acc_fixed_assets VALIDATE CONSTRAINT fk_acc_fixed_assets_org_bill;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE acc_system_account_map
  ADD CONSTRAINT fk_acc_system_account_map_org_account
  FOREIGN KEY (org_id, account_id)
  REFERENCES ledger_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE acc_system_account_map VALIDATE CONSTRAINT fk_acc_system_account_map_org_account;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE acc_tax_codes
  ADD CONSTRAINT fk_acc_tax_codes_org_collected_account
  FOREIGN KEY (org_id, collected_account_id)
  REFERENCES ledger_accounts (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE acc_tax_codes VALIDATE CONSTRAINT fk_acc_tax_codes_org_collected_account;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE acc_tax_codes
  ADD CONSTRAINT fk_acc_tax_codes_org_paid_account
  FOREIGN KEY (org_id, paid_account_id)
  REFERENCES ledger_accounts (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE acc_tax_codes VALIDATE CONSTRAINT fk_acc_tax_codes_org_paid_account;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE acc_tax_payments
  ADD CONSTRAINT fk_acc_tax_payments_org_journal_entry
  FOREIGN KEY (org_id, journal_entry_id)
  REFERENCES journal_entries (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE acc_tax_payments VALIDATE CONSTRAINT fk_acc_tax_payments_org_journal_entry;
SET lock_timeout = DEFAULT;
