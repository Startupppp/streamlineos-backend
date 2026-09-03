-- 1049 DOWN -- drops both payroll_bank_batch_item natural keys.
--
-- Lossless, and unconditionally so. 1049 creates two unique indexes and writes
-- no rows: it de-duplicates nothing and deletes nothing, and both indexes are
-- created WITHOUT "IF NOT EXISTS" precisely so a pre-existing duplicate payment
-- instruction aborts the deploy for a human to reconcile rather than being
-- resolved by the migration. There is therefore no data decision to undo --
-- dropping the two indexes returns payroll_bank_batch_items to exactly the
-- unconstrained state it is in at journal head today, where its only unique
-- objects are the surrogate primary key and uniq_payroll_bank_batch_items_org_id
-- (org_id, id).
--
-- @reopens-a-defect: this is not a neutral reversal. These are the only objects
-- at the data layer that stop the same run employee being written into a bank
-- file twice, and stop a second file being issued for a payee whose earlier
-- instruction is still in flight -- both of which are a duplicate payment
-- instruction, i.e. money leaving the account twice. Dropping them also deadens
-- the two 23505 handlers that name these constraints by string in
-- src/modules/payroll/payout/batch-creator.service.ts (BATCH_ITEM_SUBJECT_CONSTRAINT
-- and BATCH_ITEM_LIVE_SUBJECT_CONSTRAINT, isUniqueViolationOn at line 280): they
-- do not fail, they simply stop firing, and the service-side guard that only
-- excludes payees already at PAID becomes the sole defence again. Revert the two
-- uniqueIndex declarations in src/db/schema/payroll/payout.ts in the same change,
-- or the declaration and the catalog disagree.
--
-- Dropped in reverse creation order. IF EXISTS on both so the file is idempotent.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS public."uniq_payroll_bank_batch_items_live_subject";
--> statement-breakpoint

DROP INDEX IF EXISTS public."uniq_payroll_bank_batch_items_batch_subject";
