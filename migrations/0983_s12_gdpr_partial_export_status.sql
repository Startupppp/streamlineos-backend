-- @irreversible
-- S12: Add 'partial' to hr_data_request_status so a truncated GDPR export is
-- recorded honestly rather than as 'completed'. PG 12+ allows ADD VALUE inside
-- a transaction, but the new label is invisible until after commit — no column
-- DEFAULT or CHECK referencing 'partial' may appear in this same migration.
-- IF NOT EXISTS keeps this idempotent. Enum labels cannot be dropped; no rollback.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TYPE "public"."hr_data_request_status" ADD VALUE IF NOT EXISTS 'partial';
