-- DO NOT APPLY MANUALLY: managed by Drizzle migrate
-- Phase 0.5: AI feedback table + usage telemetry columns

CREATE TYPE "ai_feedback_rating" AS ENUM ('UP', 'DOWN');

CREATE TABLE "ai_feedback" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "feature" varchar(100) NOT NULL,
  "correlation_id" varchar(64),
  "entity_type" varchar(50),
  "entity_id" varchar(50),
  "rating" "ai_feedback_rating" NOT NULL,
  "reason" text,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX "idx_ai_feedback_org_feature_created" ON "ai_feedback" ("org_id", "feature", "created_at");
CREATE INDEX "idx_ai_feedback_org_correlation" ON "ai_feedback" ("org_id", "correlation_id");

ALTER TABLE "ai_usage_logs"
  ADD COLUMN "latency_ms" integer,
  ADD COLUMN "correlation_id" varchar(64),
  ADD COLUMN "outcome" varchar(20);
