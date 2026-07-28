-- 0357 — idempotency schema hardening
-- =============================================================================
-- Three fixes identified during the idempotency-work agent pass that were
-- outside that agent's exclusive ownership.
--
-- Fix 1 (§19, cross-tenant DoS): uniq_payroll_bank_batches_idempotency_key
--   is a bare non-tenant-scoped unique index. One tenant's idempotency_key
--   value blocks every other tenant from using the same string. Replaced with
--   a composite (org_id, idempotency_key) partial unique index so uniqueness
--   is scoped to a single organization.
--
-- Fix 2: payroll_command_receipts had no expires_at column. The pruning cron
--   worked around this with a finished_at + 30 days proxy, which is wrong for
--   IN_FLIGHT rows that never finished (they are never pruned). Added
--   expires_at timestamp nullable, set to started_at + 30 days on every insert
--   and reclaim by CommandReceiptsService. The cron can now filter on
--   expires_at IS NOT NULL AND expires_at < now() to catch all terminal rows
--   regardless of status.
--
-- Fix 3: inv_idempotency_keys had no dedicated lease column. StockEngineService
--   overloaded expires_at as an optimistic-lock token and used createdAt age as
--   a stale-IN_FLIGHT proxy. Added lease_expires_at timestamp nullable: set to
--   now + 15 min on every claim and reclaim; the stale-IN_FLIGHT check now
--   tests lease_expires_at <= now() instead of createdAt age; the optimistic-
--   lock WHERE clause matches on lease_expires_at. expires_at retains its
--   original meaning (24 h retention deadline for the pruning sweep).
-- =============================================================================

-- Fix 1: scope the bank-batch idempotency key per tenant
DROP INDEX IF EXISTS "uniq_payroll_bank_batches_idempotency_key";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_payroll_bank_batches_org_idempotency_key"
  ON "payroll_bank_batches" ("org_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint

-- Fix 2: expires_at on payroll_command_receipts
ALTER TABLE "payroll_command_receipts"
  ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_command_receipts_expires"
  ON "payroll_command_receipts" ("expires_at")
  WHERE "expires_at" IS NOT NULL;
--> statement-breakpoint

-- Fix 3: lease_expires_at on inv_idempotency_keys
ALTER TABLE "inv_idempotency_keys"
  ADD COLUMN IF NOT EXISTS "lease_expires_at" TIMESTAMP;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_idempotency_lease_expires"
  ON "inv_idempotency_keys" ("lease_expires_at")
  WHERE "lease_expires_at" IS NOT NULL;
