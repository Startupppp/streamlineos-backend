-- Rollback for 0842_subscription_payments_amount_paise.sql
-- CAUTION: amount_paise data is lost on rollback.
-- After rollback, also revert billing-payment-activation.ts (restore amount write,
-- remove amountPaise write) and subscriptions.ts schema (remove amountPaise column,
-- restore amount notNull), or db:generate will re-propose the forward migration.

ALTER TABLE subscription_payments DROP COLUMN IF EXISTS amount_paise;

ALTER TABLE subscription_payments ALTER COLUMN amount SET NOT NULL;

ALTER TABLE coupon_redemptions DROP COLUMN IF EXISTS amount_paise;
