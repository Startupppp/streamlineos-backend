SET statement_timeout = 0;
-- 0353 — billing idempotency backstops
-- =============================================================================
-- Bug 1 (P0): PATCH /billing/razorpay (verifyAndActivate) had no DB guard
--   against duplicate subscription_payments rows. A retried Razorpay callback
--   re-passes signature verification (same razorpay_payment_id) and a second
--   row was inserted, producing duplicate financial records.
--   Fix: unique partial index on subscription_payments.razorpay_payment_id
--   mirroring the existing uniq_platform_payments_razorpay_payment convention.
--
-- Bug 2 (P0): POST /billing/ai-credits/purchase (purchaseCreditsDirectly with
--   automatic=false) had no unique constraint on (org_id, reference_id) for
--   PURCHASE-type rows in ai_credit_transactions. Two concurrent or retried
--   calls both committed, crediting the wallet twice.
--   Fix: partial unique index mirroring the existing PLAN_GRANT guard
--   (uq_ai_credit_txns_plan_grant_ref).
--
-- Both handlers also receive @Idempotent(...) at the request layer.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_subscription_payments_razorpay_payment"
  ON "subscription_payments" ("razorpay_payment_id")
  WHERE "razorpay_payment_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ai_credit_txns_purchase_ref"
  ON "ai_credit_transactions" ("org_id", "reference_id")
  WHERE type = 'PURCHASE' AND reference_id IS NOT NULL;
