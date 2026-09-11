-- Reverses 1001. Drops the five triggers and the six functions they use.
-- payroll_run_is_locked (0445) is deliberately untouched -- it belongs to 0445.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_submitted_payroll_filing ON payroll_filings;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_released_payroll_bank_batch_item ON payroll_bank_batch_items;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_released_payroll_bank_batch ON payroll_bank_batches;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_posted_payroll_journal_batch_line ON payroll_journal_batch_lines;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_posted_payroll_journal_batch ON payroll_journal_batches;
--> statement-breakpoint

DROP FUNCTION IF EXISTS guard_submitted_payroll_filing();
--> statement-breakpoint

DROP FUNCTION IF EXISTS guard_released_payroll_bank_batch_item();
--> statement-breakpoint

DROP FUNCTION IF EXISTS guard_released_payroll_bank_batch();
--> statement-breakpoint

DROP FUNCTION IF EXISTS guard_posted_payroll_journal_batch_line();
--> statement-breakpoint

DROP FUNCTION IF EXISTS guard_posted_payroll_journal_batch();
--> statement-breakpoint

DROP FUNCTION IF EXISTS payroll_bank_batch_is_released(integer);
--> statement-breakpoint

DROP FUNCTION IF EXISTS payroll_journal_batch_is_final(integer);
--> statement-breakpoint

DROP FUNCTION IF EXISTS payroll_org_still_present(text);
