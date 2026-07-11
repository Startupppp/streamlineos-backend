DO $$ BEGIN
  CREATE TYPE "hr_webhook_delivery_status" AS ENUM ('pending', 'delivered', 'failed', 'dead');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "hr_webhook_subscriptions" (
  "id"          SERIAL PRIMARY KEY,
  "org_id"      TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name"        TEXT NOT NULL,
  "url"         TEXT NOT NULL,
  "secret"      TEXT NOT NULL,
  "events"      TEXT[] NOT NULL DEFAULT '{}',
  "is_active"   BOOLEAN NOT NULL DEFAULT TRUE,
  "created_by"  TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "deleted_at"  TIMESTAMPTZ
);

DO $$ BEGIN
  CREATE UNIQUE INDEX "uniq_hr_webhook_subscriptions_org_name"
    ON "hr_webhook_subscriptions" ("org_id", "name")
    WHERE "deleted_at" IS NULL;
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_hr_webhook_subscriptions_org_active"
  ON "hr_webhook_subscriptions" ("org_id", "is_active");

CREATE TABLE IF NOT EXISTS "hr_webhook_deliveries" (
  "id"               SERIAL PRIMARY KEY,
  "org_id"           TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "subscription_id"  INTEGER NOT NULL REFERENCES "hr_webhook_subscriptions"("id") ON DELETE CASCADE,
  "event"            TEXT NOT NULL,
  "payload"          JSONB NOT NULL DEFAULT '{}',
  "status"           "hr_webhook_delivery_status" NOT NULL DEFAULT 'pending',
  "attempts"         INTEGER NOT NULL DEFAULT 0,
  "last_attempt_at"  TIMESTAMPTZ,
  "response_status"  INTEGER,
  "error"            TEXT,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_hr_webhook_deliveries_org_sub_created"
  ON "hr_webhook_deliveries" ("org_id", "subscription_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_hr_webhook_deliveries_org_status"
  ON "hr_webhook_deliveries" ("org_id", "status");
