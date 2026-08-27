-- Custom SQL migration file, put your code below! --

-- What a subscription actually agreed to pay, and when that price was set.
--
-- Phase 3 ticket 03, the one acceptance line that was not met: "a price change
-- is dated, so an existing subscription reproduces the price in force when it
-- was agreed". `plan-pricing.ts` already refused to convert between currencies
-- for the reason the ticket gives -- a converted price moves with the exchange
-- rate and an invoice cannot be reproduced eighteen months later. It then held
-- one undated table, which has the same failure from the other direction: the
-- number moves with whoever last edited the constant, and every existing
-- customer's agreed price silently becomes the new one.
--
-- The series is now dated in `plan-pricing.ts` and these columns are how a
-- subscription names its place in it.
--
-- Nullable, and left NULL for every existing row on purpose. Those subscriptions
-- agreed to the first entry in the series, and `priceEffectiveFrom()` answers
-- for them from the series itself. Backfilling a number into them would assert
-- a fact nobody recorded -- it would look like evidence while being a guess.

SET lock_timeout = '5s';

--> statement-breakpoint
-- Three ALTERs rather than one, so a failure names the column it failed on.
-- All three are metadata-only on Postgres 11+ (nullable, no default), so this
-- does not rewrite the table however many subscriptions exist.
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "agreed_price_minor" integer;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "agreed_currency" text;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "price_effective_from" text;

--> statement-breakpoint
-- Minor units are integers and a price is not negative. Stated as a constraint
-- rather than trusted to the application because this column is the evidence a
-- charge reproduces from: a bad value here is not a bad render, it is an invoice
-- nobody can explain.
ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "chk_subscriptions_agreed_price";
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "chk_subscriptions_agreed_price"
  CHECK ("agreed_price_minor" IS NULL OR "agreed_price_minor" >= 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "subscriptions" VALIDATE CONSTRAINT "chk_subscriptions_agreed_price";

--> statement-breakpoint
-- The three travel together or not at all. A row carrying an amount with no
-- currency is the exact ambiguity `plan-pricing.ts` exists to prevent -- a
-- number in an unnamed currency is how somebody discovers at checkout that they
-- are paying rupees.
ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "chk_subscriptions_agreed_price_complete";
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "chk_subscriptions_agreed_price_complete"
  CHECK (
    ("agreed_price_minor" IS NULL AND "agreed_currency" IS NULL AND "price_effective_from" IS NULL)
    OR
    ("agreed_price_minor" IS NOT NULL AND "agreed_currency" IS NOT NULL AND "price_effective_from" IS NOT NULL)
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "subscriptions" VALIDATE CONSTRAINT "chk_subscriptions_agreed_price_complete";

--> statement-breakpoint
ANALYZE "subscriptions";
