-- @irreversible
-- Dropping the currency column would destroy denomination codes written to rows
-- created after this migration was applied. Historic rows are intentionally left
-- NULL; rows written after carry a real ISO-4217 code that cannot be recovered
-- from any other column.
--
-- 1064 — name the denomination of the money in `revenue_events`
-- =============================================================================
-- Ticket: 10-billing-payments / PRD-C125 (tax/currency)
--
-- `revenue_events` stores two integer money columns — `mrr` and `amount` — and
-- carried no currency. Two different denominations already land in them: plan
-- movements are paise of PLATFORM_PRICE_CURRENCY (from PLAN_PRICES_PAISE), while
-- a provider webhook pushes `payment.amount`, which is minor units of the
-- payment's own currency (cents for USD, whole yen for JPY, thousandths for
-- KWD). Stored side by side with no label, 100000 is 1,000.00 INR or 100,000 JPY
-- and nothing in the row says which — the last unlabelled money in billing after
-- 0561 (single-source price pairing) and the ISO-4217 minor-unit table.
--
-- Deliberately NULLable rather than `NOT NULL DEFAULT 'INR'`: backfilling every
-- historic row to INR would assert a denomination for rows written by the webhook
-- path that this migration cannot verify. NULL reads as "denomination not
-- recorded", which is the truth about rows written before the producers were
-- changed; every row written after carries its code.
--
-- Instant: adding a NULLable column with no default is a catalog-only change.
-- =============================================================================

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE revenue_events ADD COLUMN IF NOT EXISTS currency varchar(3);
--> statement-breakpoint

COMMENT ON COLUMN revenue_events.currency IS
  'ISO-4217 code denominating mrr and amount, both integer minor units. NULL on rows written before 1064.';
