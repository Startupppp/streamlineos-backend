-- 0520 — c26: Versioned commercial billing catalog
--
-- Creates the platform-global catalog tables and the two tenant-scoped tables
-- that reference them. Dependency order within this file:
--
--   billing_products
--     └── billing_plans
--           ├── billing_price_versions
--           └── billing_plan_entitlements
--   org_entitlement_overrides  (tenant-scoped; RLS required)
--   subscription_items         (tenant-scoped; RLS required)
--
-- Global catalog tables (billing_products, billing_plans, billing_price_versions,
-- billing_plan_entitlements) carry no org_id — they are platform-wide data shared
-- across all organisations. RLS is not applicable, but they are still protected with
-- REVOKE/GRANT so they are not world-readable via ALTER DEFAULT PRIVILEGES.
--
-- Operator notes — indexes
-- ────────────────────────
-- CREATE INDEX below runs inside the migration transaction (CONCURRENTLY is not
-- permitted inside a transaction block). On a live production database with tables
-- that are already large, run the CONCURRENTLY forms by hand BEFORE applying this
-- migration; the IF NOT EXISTS guards make the transaction-scoped statements a no-op:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_products_slug"
--     ON "billing_products" ("slug");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_products_active"
--     ON "billing_products" ("is_active");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_plans_product"
--     ON "billing_plans" ("product_id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_plans_tier"
--     ON "billing_plans" ("plan_tier");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_pv_plan_active"
--     ON "billing_price_versions" ("plan_id", "is_active");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_pv_plan_effective"
--     ON "billing_price_versions" ("plan_id", "effective_from");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_plan_ent_plan"
--     ON "billing_plan_entitlements" ("plan_id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_billing_plan_ent_key"
--     ON "billing_plan_entitlements" ("feature_key");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_org_ent_overrides_org_key"
--     ON "org_entitlement_overrides" ("org_id", "feature_key");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_sub_items_org_sub"
--     ON "subscription_items" ("org_id", "subscription_id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_sub_items_org_active"
--     ON "subscription_items" ("org_id", "effective_from");

SET lock_timeout = '5s';

-- ─── billing_products ────────────────────────────────────────────────────────

--> statement-breakpoint
CREATE TABLE "billing_products" (
  "id"          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "slug"        varchar(100) NOT NULL UNIQUE,
  "name"        varchar(255) NOT NULL,
  "description" text,
  "is_active"   boolean NOT NULL DEFAULT true,
  "created_at"  timestamp NOT NULL DEFAULT now(),
  "updated_at"  timestamp NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_products_slug"
  ON "billing_products" ("slug");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_products_active"
  ON "billing_products" ("is_active");

--> statement-breakpoint
REVOKE ALL ON "billing_products" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_products" TO streamline_app;

-- ─── billing_plans ───────────────────────────────────────────────────────────

--> statement-breakpoint
CREATE TABLE "billing_plans" (
  "id"           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "product_id"   bigint NOT NULL,
  "slug"         varchar(100) NOT NULL,
  "display_name" varchar(255) NOT NULL,
  "plan_tier"    varchar(20) NOT NULL,
  "sort_order"   integer NOT NULL DEFAULT 0,
  "is_active"    boolean NOT NULL DEFAULT true,
  "created_at"   timestamp NOT NULL DEFAULT now(),
  "updated_at"   timestamp NOT NULL DEFAULT now()
);

--> statement-breakpoint
ALTER TABLE "billing_plans"
  ADD CONSTRAINT "billing_plans_product_id_billing_products_id_fk"
  FOREIGN KEY ("product_id") REFERENCES "billing_products"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_plans"
  VALIDATE CONSTRAINT "billing_plans_product_id_billing_products_id_fk";

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_billing_plans_product_slug"
  ON "billing_plans" ("product_id", "slug");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_plans_product"
  ON "billing_plans" ("product_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_plans_tier"
  ON "billing_plans" ("plan_tier");

--> statement-breakpoint
REVOKE ALL ON "billing_plans" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_plans" TO streamline_app;

-- ─── billing_price_versions ──────────────────────────────────────────────────

--> statement-breakpoint
CREATE TABLE "billing_price_versions" (
  "id"                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "plan_id"           bigint NOT NULL,
  "amount_minor"      integer NOT NULL,
  "currency"          varchar(3) NOT NULL,
  "billing_interval"  varchar(20) NOT NULL,
  "tax_behavior"      varchar(20) NOT NULL,
  "effective_from"    timestamp NOT NULL,
  "effective_until"   timestamp,
  "provider_price_id" text,
  "is_active"         boolean NOT NULL DEFAULT true,
  "created_at"        timestamp NOT NULL DEFAULT now(),
  "created_by"        text
);

--> statement-breakpoint
ALTER TABLE "billing_price_versions"
  ADD CONSTRAINT "billing_price_versions_plan_id_billing_plans_id_fk"
  FOREIGN KEY ("plan_id") REFERENCES "billing_plans"("id") ON DELETE RESTRICT NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_price_versions"
  VALIDATE CONSTRAINT "billing_price_versions_plan_id_billing_plans_id_fk";

--> statement-breakpoint
ALTER TABLE "billing_price_versions"
  ADD CONSTRAINT "billing_price_versions_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_price_versions"
  VALIDATE CONSTRAINT "billing_price_versions_created_by_users_id_fk";

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_pv_plan_active"
  ON "billing_price_versions" ("plan_id", "is_active");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_pv_plan_effective"
  ON "billing_price_versions" ("plan_id", "effective_from");

--> statement-breakpoint
REVOKE ALL ON "billing_price_versions" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_price_versions" TO streamline_app;

-- ─── billing_plan_entitlements ───────────────────────────────────────────────

--> statement-breakpoint
CREATE TABLE "billing_plan_entitlements" (
  "id"              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "plan_id"         bigint NOT NULL,
  "feature_key"     varchar(100) NOT NULL,
  "limit_value"     integer,
  "effective_from"  timestamp NOT NULL,
  "effective_until" timestamp,
  "created_at"      timestamp NOT NULL DEFAULT now()
);

--> statement-breakpoint
ALTER TABLE "billing_plan_entitlements"
  ADD CONSTRAINT "billing_plan_entitlements_plan_id_billing_plans_id_fk"
  FOREIGN KEY ("plan_id") REFERENCES "billing_plans"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "billing_plan_entitlements"
  VALIDATE CONSTRAINT "billing_plan_entitlements_plan_id_billing_plans_id_fk";

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_billing_plan_ent_plan_key_from"
  ON "billing_plan_entitlements" ("plan_id", "feature_key", "effective_from");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_plan_ent_plan"
  ON "billing_plan_entitlements" ("plan_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_plan_ent_key"
  ON "billing_plan_entitlements" ("feature_key");

--> statement-breakpoint
REVOKE ALL ON "billing_plan_entitlements" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing_plan_entitlements" TO streamline_app;

-- ─── org_entitlement_overrides ───────────────────────────────────────────────
-- Tenant-scoped: durable per-org feature flag / limit overrides. RLS required.

--> statement-breakpoint
CREATE TABLE "org_entitlement_overrides" (
  "id"              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"          text NOT NULL,
  "feature_key"     varchar(100) NOT NULL,
  "limit_value"     integer,
  "reason"          text,
  "actor_id"        text,
  "idempotency_key" varchar(120),
  "effective_from"  timestamp NOT NULL,
  "effective_until" timestamp,
  "created_at"      timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_org_entitlement_overrides_org_id" UNIQUE ("org_id", "id")
);

--> statement-breakpoint
ALTER TABLE "org_entitlement_overrides"
  ADD CONSTRAINT "org_entitlement_overrides_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "org_entitlement_overrides"
  VALIDATE CONSTRAINT "org_entitlement_overrides_org_id_organizations_id_fk";

--> statement-breakpoint
ALTER TABLE "org_entitlement_overrides"
  ADD CONSTRAINT "org_entitlement_overrides_actor_id_users_id_fk"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;

--> statement-breakpoint
ALTER TABLE "org_entitlement_overrides"
  VALIDATE CONSTRAINT "org_entitlement_overrides_actor_id_users_id_fk";

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_org_ent_overrides_org_key_from"
  ON "org_entitlement_overrides" ("org_id", "feature_key", "effective_from");

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_org_ent_overrides_idem"
  ON "org_entitlement_overrides" ("org_id", "idempotency_key")
  WHERE idempotency_key IS NOT NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_ent_overrides_org_key"
  ON "org_entitlement_overrides" ("org_id", "feature_key");

--> statement-breakpoint
ALTER TABLE "org_entitlement_overrides" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "org_entitlement_overrides";

--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "org_entitlement_overrides"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

--> statement-breakpoint
REVOKE ALL ON "org_entitlement_overrides" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "org_entitlement_overrides" TO streamline_app;

-- ─── subscription_items ──────────────────────────────────────────────────────
-- Tenant-scoped: one row per billed item on a subscription, pinned to the
-- immutable price version that was purchased. RLS required.

--> statement-breakpoint
CREATE TABLE "subscription_items" (
  "id"               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "subscription_id"  integer NOT NULL,
  "org_id"           text NOT NULL,
  "price_version_id" bigint NOT NULL,
  "quantity"         integer NOT NULL DEFAULT 1,
  "effective_from"   timestamp NOT NULL,
  "effective_until"  timestamp,
  "created_at"       timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_subscription_items_org_id" UNIQUE ("org_id", "id")
);

--> statement-breakpoint
ALTER TABLE "subscription_items"
  ADD CONSTRAINT "subscription_items_subscription_id_subscriptions_id_fk"
  FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "subscription_items"
  VALIDATE CONSTRAINT "subscription_items_subscription_id_subscriptions_id_fk";

--> statement-breakpoint
ALTER TABLE "subscription_items"
  ADD CONSTRAINT "subscription_items_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "subscription_items"
  VALIDATE CONSTRAINT "subscription_items_org_id_organizations_id_fk";

--> statement-breakpoint
ALTER TABLE "subscription_items"
  ADD CONSTRAINT "subscription_items_price_version_id_billing_price_versions_id_fk"
  FOREIGN KEY ("price_version_id") REFERENCES "billing_price_versions"("id") ON DELETE RESTRICT NOT VALID;

--> statement-breakpoint
ALTER TABLE "subscription_items"
  VALIDATE CONSTRAINT "subscription_items_price_version_id_billing_price_versions_id_fk";

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sub_items_org_sub"
  ON "subscription_items" ("org_id", "subscription_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sub_items_org_active"
  ON "subscription_items" ("org_id", "effective_from");

--> statement-breakpoint
ALTER TABLE "subscription_items" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "subscription_items";

--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subscription_items"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

--> statement-breakpoint
REVOKE ALL ON "subscription_items" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "subscription_items" TO streamline_app;
