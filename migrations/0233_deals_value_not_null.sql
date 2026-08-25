-- Make the database agree with the schema about `deals.value`.
--
-- `0214` replaced `value` with a column generated from `value_minor`, but
-- created it nullable; `src/db/schema/crm/deals.ts` declares it `.notNull()`.
-- The declaration is the one telling the truth — `value_minor` is NOT NULL and
-- `value` is derived from it arithmetically, so no row can carry a null here.
--
-- Left alone, the drift is a trap rather than a bug: it is invisible until
-- somebody reconciles the schema, and it is the benign direction (a
-- reconciliation would emit this same statement). Closing it costs one
-- migration; leaving it costs a surprise inside whatever larger change
-- eventually triggers the reconciliation.
--
-- The two-step is the same one `0214` uses on `value_minor` twenty lines
-- earlier, and for the same reason: a bare `SET NOT NULL` scans the whole table
-- under ACCESS EXCLUSIVE, while validating a NOT VALID check takes only a
-- SHARE UPDATE EXCLUSIVE and lets reads and writes continue.

ALTER TABLE "deals" ADD CONSTRAINT "chk_deals_value_present"
  CHECK ("value" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "deals" VALIDATE CONSTRAINT "chk_deals_value_present";
--> statement-breakpoint
ALTER TABLE "deals" ALTER COLUMN "value" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "deals" DROP CONSTRAINT "chk_deals_value_present";
