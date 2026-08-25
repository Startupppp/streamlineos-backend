-- An employee expense claim is a distinct source of a journal, not a manual
-- entry. Without its own member the reimbursement posting had to claim
-- `sourceType: "manual"` while carrying an expense id as its source id — which
-- reads as an accountant's hand-typed journal in every audit trail and report.
--
-- Hand-authored for the reason given in 0464: `migrations/meta` snapshots stop
-- at 0231, so `drizzle-kit generate` is unusable in this repo.
--
-- `ADD VALUE` is safe inside a transaction on PG12+, but the new label cannot be
-- USED until that transaction commits — which is fine here, since nothing in
-- this migration writes a journal.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TYPE "public"."gl_journal_source" ADD VALUE IF NOT EXISTS 'expense_claim' AFTER 'payroll_run';
