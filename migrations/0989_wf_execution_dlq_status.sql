-- Written but NOT applied. Apply with `pnpm db:migrate` after review.
-- Adds a distinct `dead_lettered` status for workflow executions whose
-- infrastructure retry budget is exhausted, making them queryable and
-- distinguishable from deterministic domain failures (`failed`).
-- Also adds `dlq_reason` for direct SQL inspection without JSONB extraction.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TYPE workflow_execution_status ADD VALUE IF NOT EXISTS 'dead_lettered';
--> statement-breakpoint
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS dlq_reason text;
