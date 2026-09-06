-- 0960 DOWN — drops all bank/tax/acc composite tenant FK constraints.
--
-- @reopens-a-defect: the composite tenant FKs on bank, tax, and acc tables are removed,
-- so rows in bank_matches, bank_profiles, bank_statement_lines, bank_statements,
-- tax_codes, tax_document_lines, tax_gl_map, tax_rates, tax_registrations,
-- acc_asset_categories, acc_depreciation_runs, acc_depreciation_schedules,
-- acc_fixed_assets, acc_system_account_map, acc_tax_codes, and acc_tax_payments can
-- reference mismatched org_id pairs without the DB raising an error.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE bank_matches DROP CONSTRAINT IF EXISTS fk_bank_matches_org_payment;
ALTER TABLE bank_matches DROP CONSTRAINT IF EXISTS fk_bank_matches_org_receipt;
ALTER TABLE bank_matches DROP CONSTRAINT IF EXISTS fk_bank_matches_org_statement_line;
ALTER TABLE bank_matches DROP CONSTRAINT IF EXISTS fk_bank_matches_org_book;
ALTER TABLE bank_matches DROP CONSTRAINT IF EXISTS fk_bank_matches_org_journal;
ALTER TABLE bank_profiles DROP CONSTRAINT IF EXISTS fk_bank_profiles_org_account;
ALTER TABLE bank_profiles DROP CONSTRAINT IF EXISTS fk_bank_profiles_org_book;
ALTER TABLE bank_statement_lines DROP CONSTRAINT IF EXISTS fk_bank_statement_lines_org_statement;
ALTER TABLE bank_statements DROP CONSTRAINT IF EXISTS fk_bank_statements_org_bank_profile;
ALTER TABLE bank_statements DROP CONSTRAINT IF EXISTS fk_bank_statements_org_book;
ALTER TABLE tax_codes DROP CONSTRAINT IF EXISTS fk_tax_codes_org_book;
ALTER TABLE tax_document_lines DROP CONSTRAINT IF EXISTS fk_tax_document_lines_org_gl_account;
ALTER TABLE tax_document_lines DROP CONSTRAINT IF EXISTS fk_tax_document_lines_org_book;
ALTER TABLE tax_document_lines DROP CONSTRAINT IF EXISTS fk_tax_document_lines_org_tax_code;
ALTER TABLE tax_gl_map DROP CONSTRAINT IF EXISTS fk_tax_gl_map_org_account;
ALTER TABLE tax_gl_map DROP CONSTRAINT IF EXISTS fk_tax_gl_map_org_book;
ALTER TABLE tax_rates DROP CONSTRAINT IF EXISTS fk_tax_rates_org_tax_code;
ALTER TABLE tax_registrations DROP CONSTRAINT IF EXISTS fk_tax_registrations_org_book;
ALTER TABLE tax_registrations DROP CONSTRAINT IF EXISTS fk_tax_registrations_org_party;
ALTER TABLE acc_asset_categories DROP CONSTRAINT IF EXISTS fk_acc_asset_categories_org_accum_depr_acct;
ALTER TABLE acc_asset_categories DROP CONSTRAINT IF EXISTS fk_acc_asset_categories_org_asset_acct;
ALTER TABLE acc_asset_categories DROP CONSTRAINT IF EXISTS fk_acc_asset_categories_org_depr_exp_acct;
ALTER TABLE acc_depreciation_runs DROP CONSTRAINT IF EXISTS fk_acc_depreciation_runs_org_journal_entry;
ALTER TABLE acc_depreciation_schedules DROP CONSTRAINT IF EXISTS fk_acc_depreciation_schedules_org_run;
ALTER TABLE acc_depreciation_schedules DROP CONSTRAINT IF EXISTS fk_acc_depreciation_schedules_org_asset;
ALTER TABLE acc_depreciation_schedules DROP CONSTRAINT IF EXISTS fk_acc_depreciation_schedules_org_journal;
ALTER TABLE acc_fixed_assets DROP CONSTRAINT IF EXISTS fk_acc_fixed_assets_org_category;
ALTER TABLE acc_fixed_assets DROP CONSTRAINT IF EXISTS fk_acc_fixed_assets_org_disposal_journal;
ALTER TABLE acc_fixed_assets DROP CONSTRAINT IF EXISTS fk_acc_fixed_assets_org_bill;
ALTER TABLE acc_system_account_map DROP CONSTRAINT IF EXISTS fk_acc_system_account_map_org_account;
ALTER TABLE acc_tax_codes DROP CONSTRAINT IF EXISTS fk_acc_tax_codes_org_collected_account;
ALTER TABLE acc_tax_codes DROP CONSTRAINT IF EXISTS fk_acc_tax_codes_org_paid_account;
ALTER TABLE acc_tax_payments DROP CONSTRAINT IF EXISTS fk_acc_tax_payments_org_journal_entry;
