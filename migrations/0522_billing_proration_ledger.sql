-- 0522 — c26: Billing proration line ledger
--
-- Immutable proration lines produced on every upgrade, downgrade or seat-quantity
-- change. Each line captures the old and new price versions, the effective interval,
-- quantity, currency (integer minor units) and rounding rule — enough to reconstruct
-- the proration calculation without touching the catalog again.
--
-- provider_amount_minor stores the amount the payment provider calculated for
-- reconciliation; reconciled_at is stamped when the line is confirmed against the
-- provider's proration event.
--
-- The idempotency unique constraint (org_id, idempotency_key) makes duplicate
-- submissions safe — a service must also return the stored result on replay.
--
-- Depends on: 0520 (billing_price_versions, subscriptions already exists)
--
-- Operator notes — indexes
-- ────────────────────────
-- Run CONCURRENTLY forms by hand before applying on a live table:
--
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_billing_proration_org_idem"
--     ON "billing_proration_lines" ("org_id", "idempotency_key");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_proration_org_sub"
--     ON "billing_proration_lines" ("org_id", "subscription_id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_proration_org_from"
--     ON "billing_proration_lines" ("org_id", "effective_from");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_proration_unreconciled"
--     ON "billing_proration_lines" ("org_id")
--     WHERE reconciled_at IS NULL AND provider_ref IS NOT NULL;

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE "billing_proration_lines" (
  "id"                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"                text NOT NULL,
  "subscription_id"       integer NOT NULL,
  "idempotency_key"       varchar(120) NOT NULL,
  "line_type"             varchar(20) NOT NULL,
  "old_price_version_id"  bigint,
  "new_price_version_id"  bigint,
  "effective_from"        timestamp NOT NULL,
  "effective_until"       timestamp NOT NULL,
  "quantity"              integer NOT NULL,
  "currency"              varchar(3) NOT NULL,
  "amount_minor"          integer NOT NULL,
  "rounding_rule"         varchar(10) NOT NULL DEFAULT 'HALF_UP',
  "provider_amount_minor" integer,
  "provider_ref"          text,
  "reconciled_at"         timestamp,
  "created_at"            timestamp NOT NULL DEFAULT now(),
  "created_by"            text,
  CONSTRAINT "uniq_billing_proration_lines_org_id" UNIQUE ("org_id", "id")
);

--> statement-breakpoint
ALTER TABLE "billing_proration_lines"
  ADD CONSTRAINT "billing_proration_lines_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_proration_lines"
  VALIDATE CONSTRAINT "billing_proration_lines_org_id_organizations_id_fk";

--> statement-breakpoint
ALTER TABLE "billing_proration_lines"
  ADD CONSTRAINT "billing_proration_lines_subscription_id_subscriptions_id_fk"
  FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_proration_lines"
  VALIDATE CONSTRAINT "billing_proration_lines_subscription_id_subscriptions_id_fk";

--> statement-breakpoint
ALTER TABLE "billing_proration_lines"
  ADD CONSTRAINT "billing_proration_lines_old_price_version_id_billing_price_versions_id_fk"
  FOREIGN KEY ("old_price_version_id") REFERENCES "billing_price_versions"("id") ON DELETE RESTRICT NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_proration_lines"
  VALIDATE CONSTRAINT "billing_proration_lines_old_price_version_id_billing_price_versions_id_fk";

--> statement-breakpoint
ALTER TABLE "billing_proration_lines"
  ADD CONSTRAINT "billing_proration_lines_new_price_version_id_billing_price_versions_id_fk"
  FOREIGN KEY ("new_price_version_id") REFERENCES "billing_price_versions"("id") ON DELETE RESTRICT NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_proration_lines"
  VALIDATE CONSTRAINT "billing_proration_lines_new_price_version_id_billing_price_versions_id_fk";

--> statement-breakpoint
ALTER TABLE "billing_proration_lines"
  ADD CONSTRAINT "billing_proration_lines_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_proration_lines"
  VALIDATE CONSTRAINT "billing_proration_lines_created_by_users_id_fk";

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_billing_proration_org_idem"
  ON "billing_proration_lines" ("org_id", "idempotency_key");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_proration_org_sub"
  ON "billing_proration_lines" ("org_id", "subscription_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_proration_org_from"
  ON "billing_proration_lines" ("org_id", "effective_from");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_proration_unreconciled"
  ON "billing_proration_lines" ("org_id")
  WHERE reconciled_at IS NULL AND provider_ref IS NOT NULL;

--> statement-breakpoint
ALTER TABLE "billing_proration_lines" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "billing_proration_lines";

--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "billing_proration_lines"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

--> statement-breakpoint
REVOKE ALL ON "billing_proration_lines" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_proration_lines" TO streamline_app;
