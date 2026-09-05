-- AR-02: composite tenant FKs — GL tables
-- Covers: gl_accounts, gl_book_currencies, gl_books, gl_document_attachments,
--         gl_document_compliance, gl_document_sequences, gl_fiscal_years,
--         gl_fx_rates, gl_journal_lines, gl_journals, gl_parties, gl_periods

SET lock_timeout = DEFAULT;

ALTER TABLE gl_accounts
  ADD CONSTRAINT fk_gl_accounts_org_parent_account
  FOREIGN KEY (org_id, parent_account_id)
  REFERENCES gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_accounts VALIDATE CONSTRAINT fk_gl_accounts_org_parent_account;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_accounts
  ADD CONSTRAINT fk_gl_accounts_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_accounts VALIDATE CONSTRAINT fk_gl_accounts_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_book_currencies
  ADD CONSTRAINT fk_gl_book_currencies_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_book_currencies VALIDATE CONSTRAINT fk_gl_book_currencies_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_books
  ADD CONSTRAINT fk_gl_books_org_parent_book
  FOREIGN KEY (org_id, parent_book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE SET NULL (parent_book_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_books VALIDATE CONSTRAINT fk_gl_books_org_parent_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_books
  ADD CONSTRAINT fk_gl_books_org_legal_entity
  FOREIGN KEY (org_id, legal_entity_id)
  REFERENCES legal_entities (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_books VALIDATE CONSTRAINT fk_gl_books_org_legal_entity;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_document_attachments
  ADD CONSTRAINT fk_gl_document_attachments_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_document_attachments VALIDATE CONSTRAINT fk_gl_document_attachments_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_document_compliance
  ADD CONSTRAINT fk_gl_document_compliance_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_document_compliance VALIDATE CONSTRAINT fk_gl_document_compliance_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_document_sequences
  ADD CONSTRAINT fk_gl_document_sequences_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_document_sequences VALIDATE CONSTRAINT fk_gl_document_sequences_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_document_sequences
  ADD CONSTRAINT fk_gl_document_sequences_org_fiscal_year
  FOREIGN KEY (org_id, fiscal_year_id)
  REFERENCES gl_fiscal_years (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_document_sequences VALIDATE CONSTRAINT fk_gl_document_sequences_org_fiscal_year;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_fiscal_years
  ADD CONSTRAINT fk_gl_fiscal_years_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_fiscal_years VALIDATE CONSTRAINT fk_gl_fiscal_years_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_fx_rates
  ADD CONSTRAINT fk_gl_fx_rates_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_fx_rates VALIDATE CONSTRAINT fk_gl_fx_rates_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_journal_lines
  ADD CONSTRAINT fk_gl_journal_lines_org_account
  FOREIGN KEY (org_id, account_id)
  REFERENCES gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_journal_lines VALIDATE CONSTRAINT fk_gl_journal_lines_org_account;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_journal_lines
  ADD CONSTRAINT fk_gl_journal_lines_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_journal_lines VALIDATE CONSTRAINT fk_gl_journal_lines_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_journal_lines
  ADD CONSTRAINT fk_gl_journal_lines_org_fx_rate
  FOREIGN KEY (org_id, fx_rate_id)
  REFERENCES gl_fx_rates (org_id, id)
  ON DELETE SET NULL (fx_rate_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_journal_lines VALIDATE CONSTRAINT fk_gl_journal_lines_org_fx_rate;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_journal_lines
  ADD CONSTRAINT fk_gl_journal_lines_org_journal
  FOREIGN KEY (org_id, journal_id)
  REFERENCES gl_journals (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_journal_lines VALIDATE CONSTRAINT fk_gl_journal_lines_org_journal;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_journal_lines
  ADD CONSTRAINT fk_gl_journal_lines_org_dim_branch
  FOREIGN KEY (org_id, dimension_branch_id)
  REFERENCES org_units (org_id, id)
  ON DELETE SET NULL (dimension_branch_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_journal_lines VALIDATE CONSTRAINT fk_gl_journal_lines_org_dim_branch;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_journal_lines
  ADD CONSTRAINT fk_gl_journal_lines_org_dim_project
  FOREIGN KEY (org_id, dimension_project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE SET NULL (dimension_project_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_journal_lines VALIDATE CONSTRAINT fk_gl_journal_lines_org_dim_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_journals
  ADD CONSTRAINT fk_gl_journals_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_journals VALIDATE CONSTRAINT fk_gl_journals_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_journals
  ADD CONSTRAINT fk_gl_journals_org_reversed_by_journal
  FOREIGN KEY (org_id, reversed_by_journal_id)
  REFERENCES gl_journals (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_journals VALIDATE CONSTRAINT fk_gl_journals_org_reversed_by_journal;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_journals
  ADD CONSTRAINT fk_gl_journals_org_reverses_journal
  FOREIGN KEY (org_id, reverses_journal_id)
  REFERENCES gl_journals (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_journals VALIDATE CONSTRAINT fk_gl_journals_org_reverses_journal;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_journals
  ADD CONSTRAINT fk_gl_journals_org_period
  FOREIGN KEY (org_id, period_id)
  REFERENCES gl_periods (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_journals VALIDATE CONSTRAINT fk_gl_journals_org_period;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_parties
  ADD CONSTRAINT fk_gl_parties_org_def_expense_account
  FOREIGN KEY (org_id, default_expense_account_id)
  REFERENCES gl_accounts (org_id, id)
  ON DELETE SET NULL (default_expense_account_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_parties VALIDATE CONSTRAINT fk_gl_parties_org_def_expense_account;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_parties
  ADD CONSTRAINT fk_gl_parties_org_def_income_account
  FOREIGN KEY (org_id, default_income_account_id)
  REFERENCES gl_accounts (org_id, id)
  ON DELETE SET NULL (default_income_account_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_parties VALIDATE CONSTRAINT fk_gl_parties_org_def_income_account;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_parties
  ADD CONSTRAINT fk_gl_parties_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_parties VALIDATE CONSTRAINT fk_gl_parties_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_periods
  ADD CONSTRAINT fk_gl_periods_org_book
  FOREIGN KEY (org_id, book_id)
  REFERENCES gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_periods VALIDATE CONSTRAINT fk_gl_periods_org_book;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE gl_periods
  ADD CONSTRAINT fk_gl_periods_org_fiscal_year
  FOREIGN KEY (org_id, fiscal_year_id)
  REFERENCES gl_fiscal_years (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE gl_periods VALIDATE CONSTRAINT fk_gl_periods_org_fiscal_year;
SET lock_timeout = DEFAULT;
