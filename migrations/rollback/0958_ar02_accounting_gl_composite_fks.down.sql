-- 0958 DOWN — drops all GL composite tenant FK constraints.
--
-- @reopens-a-defect: the 26 composite tenant FKs on GL tables are removed, so a row
-- in gl_accounts, gl_journal_lines, gl_journals, gl_parties, gl_periods, etc. can
-- reference an org_id/book_id or org_id/account_id pair from a different tenant
-- without the DB raising an error. Referential integrity across GL sub-tables reverts
-- to application-layer enforcement only.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE gl_accounts DROP CONSTRAINT IF EXISTS fk_gl_accounts_org_parent_account;
ALTER TABLE gl_accounts DROP CONSTRAINT IF EXISTS fk_gl_accounts_org_book;
ALTER TABLE gl_book_currencies DROP CONSTRAINT IF EXISTS fk_gl_book_currencies_org_book;
ALTER TABLE gl_books DROP CONSTRAINT IF EXISTS fk_gl_books_org_parent_book;
ALTER TABLE gl_books DROP CONSTRAINT IF EXISTS fk_gl_books_org_legal_entity;
ALTER TABLE gl_document_attachments DROP CONSTRAINT IF EXISTS fk_gl_document_attachments_org_book;
ALTER TABLE gl_document_compliance DROP CONSTRAINT IF EXISTS fk_gl_document_compliance_org_book;
ALTER TABLE gl_document_sequences DROP CONSTRAINT IF EXISTS fk_gl_document_sequences_org_book;
ALTER TABLE gl_document_sequences DROP CONSTRAINT IF EXISTS fk_gl_document_sequences_org_fiscal_year;
ALTER TABLE gl_fiscal_years DROP CONSTRAINT IF EXISTS fk_gl_fiscal_years_org_book;
ALTER TABLE gl_fx_rates DROP CONSTRAINT IF EXISTS fk_gl_fx_rates_org_book;
ALTER TABLE gl_journal_lines DROP CONSTRAINT IF EXISTS fk_gl_journal_lines_org_account;
ALTER TABLE gl_journal_lines DROP CONSTRAINT IF EXISTS fk_gl_journal_lines_org_book;
ALTER TABLE gl_journal_lines DROP CONSTRAINT IF EXISTS fk_gl_journal_lines_org_fx_rate;
ALTER TABLE gl_journal_lines DROP CONSTRAINT IF EXISTS fk_gl_journal_lines_org_journal;
ALTER TABLE gl_journal_lines DROP CONSTRAINT IF EXISTS fk_gl_journal_lines_org_dim_branch;
ALTER TABLE gl_journal_lines DROP CONSTRAINT IF EXISTS fk_gl_journal_lines_org_dim_project;
ALTER TABLE gl_journals DROP CONSTRAINT IF EXISTS fk_gl_journals_org_book;
ALTER TABLE gl_journals DROP CONSTRAINT IF EXISTS fk_gl_journals_org_reversed_by_journal;
ALTER TABLE gl_journals DROP CONSTRAINT IF EXISTS fk_gl_journals_org_reverses_journal;
ALTER TABLE gl_journals DROP CONSTRAINT IF EXISTS fk_gl_journals_org_period;
ALTER TABLE gl_parties DROP CONSTRAINT IF EXISTS fk_gl_parties_org_def_expense_account;
ALTER TABLE gl_parties DROP CONSTRAINT IF EXISTS fk_gl_parties_org_def_income_account;
ALTER TABLE gl_parties DROP CONSTRAINT IF EXISTS fk_gl_parties_org_book;
ALTER TABLE gl_periods DROP CONSTRAINT IF EXISTS fk_gl_periods_org_book;
ALTER TABLE gl_periods DROP CONSTRAINT IF EXISTS fk_gl_periods_org_fiscal_year;
