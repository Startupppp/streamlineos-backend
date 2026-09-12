-- 0910.down — Revert the quality-hold stock grain.
--
-- Reverses the two columns 0910 added to inv_quality_holds, the foreign key it
-- installed over (org_id, handling_unit_id) and the two partial indexes. The
-- forward migration is purely additive, so this is a true inverse of the schema.
--
-- It is not an inverse of the data, and `pnpm drill:rollback` measured exactly
-- that: a hold recorded as VENDOR-owned came back OWNED after down-then-forward,
-- with handling_unit_id NULL. Reapplying 0910 restores the columns at their
-- defaults, so every value that was in them is gone. Declared rather than
-- discovered during an incident:
--
-- @data-loss: inv_quality_holds
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_qh_org_ownership";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_qh_org_hu";
--> statement-breakpoint
ALTER TABLE "inv_quality_holds" DROP CONSTRAINT IF EXISTS "fk_inv_quality_holds_handling_unit_org";
--> statement-breakpoint
ALTER TABLE "inv_quality_holds" DROP COLUMN IF EXISTS "ownership";
--> statement-breakpoint
ALTER TABLE "inv_quality_holds" DROP COLUMN IF EXISTS "handling_unit_id";
