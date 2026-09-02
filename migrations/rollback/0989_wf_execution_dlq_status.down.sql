-- 0989 DOWN — drops dlq_reason. The enum label cannot be removed: PostgreSQL has no ALTER TYPE ... DROP VALUE, so 'dead_lettered' is permanent once added and any execution already carrying it would lose its status.
-- @irreversible

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE workflow_executions DROP COLUMN IF EXISTS dlq_reason;
