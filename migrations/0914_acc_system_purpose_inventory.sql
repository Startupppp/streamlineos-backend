-- @irreversible
--
-- Not because anything here is destructive — nothing is dropped, nothing is
-- backfilled, and a tenant who never opens the settings screen sees no change.
-- It is irreversible because PostgreSQL has no `ALTER TYPE ... DROP VALUE`: an
-- enum label, once added, cannot be removed. The only way back is to rebuild the
-- type and rewrite every column that uses it, which for `acc_system_purpose`
-- means `acc_system_account_map` and would take an ACCESS EXCLUSIVE lock to undo
-- six labels nothing is obliged to use.
--
-- Written as a declaration rather than a rollback file that pretends: a
-- `.down.sql` here could only be a no-op or a lie, and `check:migration-rollback`
-- exists precisely so the difference is stated instead of assumed.

-- INV-09 — the six inventory account mappings, as purposes an admin can map.
--
-- `acc_system_account_map` already carries eighteen system-account purposes with
-- a service, a controller, validation and per-tenant storage behind them.
-- Inventory used none of them: `GL_POSTING_RULES` and the four journal builders
-- name "1300", "2000" and "5000" as string literals, so the accounting bridge
-- works only for tenants whose chart of accounts happens to match the hardcoded
-- one. A tenant whose inventory asset account is not numbered 1300 gets a skip
-- and a MISSING_COA row rather than a mis-posting, which is honest, but it is
-- not a mapping.
--
-- This adds the labels. It does not change what any journal posts: the six
-- default codes are the codes those journals already use, so a tenant who never
-- opens the settings screen sees no difference. What changes is that mapping
-- becomes possible at all.
--
-- `ALTER TYPE … ADD VALUE` inside a transaction block is legal from PostgreSQL
-- 12 on, with one rule: the new label may not be *used* before the transaction
-- commits. Nothing below references these labels — there is no backfill here,
-- deliberately. An unmapped purpose already means "fall back to the default
-- code", so writing a row per organisation would replace a working default with
-- eighteen thousand rows that say the same thing, and would freeze today's code
-- into every tenant that had never asked for it.
--
-- Appended rather than grouped with the accounting purposes above them: an
-- existing enum label cannot be reordered, and nothing sorts on this type.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TYPE "public"."acc_system_purpose" ADD VALUE IF NOT EXISTS 'INVENTORY_ASSET';
--> statement-breakpoint

ALTER TYPE "public"."acc_system_purpose" ADD VALUE IF NOT EXISTS 'INVENTORY_COGS';
--> statement-breakpoint

ALTER TYPE "public"."acc_system_purpose" ADD VALUE IF NOT EXISTS 'INVENTORY_GRNI';
--> statement-breakpoint

ALTER TYPE "public"."acc_system_purpose" ADD VALUE IF NOT EXISTS 'INVENTORY_LANDED_COST_CLEARING';
--> statement-breakpoint

ALTER TYPE "public"."acc_system_purpose" ADD VALUE IF NOT EXISTS 'INVENTORY_WRITE_OFF';
--> statement-breakpoint

ALTER TYPE "public"."acc_system_purpose" ADD VALUE IF NOT EXISTS 'INVENTORY_ADJUSTMENT_GAIN_LOSS';
