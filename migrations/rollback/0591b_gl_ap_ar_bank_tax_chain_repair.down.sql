-- @data-loss
-- Rollback for 0591b_gl_ap_ar_bank_tax_chain_repair.
--
-- Drops the 31 tables and 22 enum types created by the forward migration.
-- This rollback is destructive: the tables may carry data on production and
-- the enum types are referenced by tables not created in this migration.
-- Only run after confirming no dependent objects remain.
-- On production this migration will be applied by `pnpm db:migrate` with all
-- IF NOT EXISTS guards firing as no-ops. The rollback is safe to run on any
-- environment where the tables exist and can be dropped.

SET lock_timeout = '5s';

DROP TABLE IF EXISTS "public"."subprocessor_subscribers";
DROP TABLE IF EXISTS "public"."tax_registrations";
DROP TABLE IF EXISTS "public"."tax_document_lines";
DROP TABLE IF EXISTS "public"."tax_gl_map";
DROP TABLE IF EXISTS "public"."tax_rates";
DROP TABLE IF EXISTS "public"."tax_codes";
DROP TABLE IF EXISTS "public"."bank_matches";
DROP TABLE IF EXISTS "public"."bank_statement_lines";
DROP TABLE IF EXISTS "public"."bank_statements";
DROP TABLE IF EXISTS "public"."bank_profiles";
DROP TABLE IF EXISTS "public"."ar_allocations";
DROP TABLE IF EXISTS "public"."ar_receipts";
DROP TABLE IF EXISTS "public"."ar_document_lines";
DROP TABLE IF EXISTS "public"."ar_documents";
DROP TABLE IF EXISTS "public"."ap_withholding";
DROP TABLE IF EXISTS "public"."ap_allocations";
DROP TABLE IF EXISTS "public"."ap_payments";
DROP TABLE IF EXISTS "public"."ap_document_lines";
DROP TABLE IF EXISTS "public"."ap_documents";
DROP TABLE IF EXISTS "public"."gl_book_currencies";
DROP TABLE IF EXISTS "public"."gl_document_compliance";
DROP TABLE IF EXISTS "public"."gl_document_attachments";
DROP TABLE IF EXISTS "public"."gl_journal_lines";
DROP TABLE IF EXISTS "public"."gl_journals";
DROP TABLE IF EXISTS "public"."gl_parties";
DROP TABLE IF EXISTS "public"."gl_document_sequences";
DROP TABLE IF EXISTS "public"."gl_accounts";
DROP TABLE IF EXISTS "public"."gl_periods";
DROP TABLE IF EXISTS "public"."gl_fiscal_years";
DROP TABLE IF EXISTS "public"."gl_fx_rates";
DROP TABLE IF EXISTS "public"."gl_books";

DROP TYPE IF EXISTS "public"."tax_supply_nature";
DROP TYPE IF EXISTS "public"."tax_registration_owner";
DROP TYPE IF EXISTS "public"."tax_regime";
DROP TYPE IF EXISTS "public"."tax_gl_role";
DROP TYPE IF EXISTS "public"."tax_category";
DROP TYPE IF EXISTS "public"."party_role";
DROP TYPE IF EXISTS "public"."gl_system_tag";
DROP TYPE IF EXISTS "public"."gl_period_status";
DROP TYPE IF EXISTS "public"."gl_journal_source";
DROP TYPE IF EXISTS "public"."gl_fiscal_year_status";
DROP TYPE IF EXISTS "public"."gl_book_status";
DROP TYPE IF EXISTS "public"."gl_account_type";
DROP TYPE IF EXISTS "public"."compliance_transport";
DROP TYPE IF EXISTS "public"."compliance_status";
DROP TYPE IF EXISTS "public"."compliance_enforcement";
DROP TYPE IF EXISTS "public"."bank_statement_source";
DROP TYPE IF EXISTS "public"."bank_match_kind";
DROP TYPE IF EXISTS "public"."bank_identifier_scheme";
DROP TYPE IF EXISTS "public"."ar_document_type";
DROP TYPE IF EXISTS "public"."ap_document_type";
DROP TYPE IF EXISTS "public"."acct_settlement_status";
DROP TYPE IF EXISTS "public"."acct_document_status";
