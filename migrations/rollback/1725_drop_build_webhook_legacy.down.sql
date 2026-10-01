SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."project_webhooks"
  ADD COLUMN IF NOT EXISTS "secret" TEXT;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."webhook_deliveries" (
  "id" BIGSERIAL PRIMARY KEY,
  "org_id" TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "webhook_id" INTEGER NOT NULL,
  "event" VARCHAR(100) NOT NULL,
  "payload" JSONB,
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "response_code" INTEGER,
  "response_body" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "next_attempt_at" TIMESTAMPTZ,
  "delivered_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "fk_webhook_deliveries_org_webhook"
    FOREIGN KEY ("org_id", "webhook_id")
    REFERENCES "build"."project_webhooks"("org_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "uniq_webhook_deliveries_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_webhook_deliveries_status" CHECK ("status" IN ('pending','success','failed'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_webhook_id"
  ON "build"."webhook_deliveries" ("webhook_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_delivered_at"
  ON "build"."webhook_deliveries" ("delivered_at");
