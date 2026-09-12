-- The contract half that `0269_payment_provider_columns.sql` promised and never got.
--
-- 0269 added `provider`, `provider_payment_ref` and friends alongside the
-- Razorpay-named columns, and left the old ones in place so nothing broke while
-- readers moved over. It said the provider-ref uniqueness was "partial, because
-- the column is nullable until the contract migration". This is that migration,
-- for the one column that actually blocks a second provider.
--
-- `platform_payments.razorpay_payment_id` is NOT NULL. A Stripe payment has no
-- Razorpay payment id, so a Stripe row cannot be inserted at all -- the second
-- provider was unreachable at the schema, not at the credentials, which is what
-- ticket 02's status line ("only Stripe credentials are missing") had wrong.
--
-- Dropping NOT NULL is a catalog-only change: it rewrites a pg_attribute flag
-- and takes no table rewrite, so the ACCESS EXCLUSIVE lock is held for microseconds.
-- The lock_timeout is here anyway, so it fails fast rather than queueing behind
-- a long read and blocking every write to the table in the meantime.
--
-- Uniqueness is not weakened. `uniq_platform_payments_razorpay_payment` stays and
-- becomes partial, so it constrains exactly the rows that carry a Razorpay id.
-- Postgres already treats NULLs as distinct in a unique index, so the plain form
-- would have admitted many Stripe rows too -- the partial form says that is
-- intended rather than leaving it to be rediscovered from the NULL semantics.
-- Stripe rows are protected by `uniq_platform_payments_provider_ref` from 0269,
-- which is unique on (provider, provider_payment_ref).
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "platform_payments" ALTER COLUMN "razorpay_payment_id" DROP NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_platform_payments_razorpay_payment";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_platform_payments_razorpay_payment"
  ON "platform_payments" ("razorpay_payment_id")
  WHERE "razorpay_payment_id" IS NOT NULL;
