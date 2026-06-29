CREATE TABLE IF NOT EXISTS "ai_usage_logs" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "feature" text NOT NULL,
  "model" text NOT NULL,
  "prompt_tokens" integer NOT NULL DEFAULT 0,
  "completion_tokens" integer NOT NULL DEFAULT 0,
  "total_tokens" integer NOT NULL DEFAULT 0,
  "estimated_cost_usd" numeric(12, 6),
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_ai_usage_org_feature" ON "ai_usage_logs" ("org_id", "feature");
CREATE INDEX IF NOT EXISTS "idx_ai_usage_org_created" ON "ai_usage_logs" ("org_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_ai_usage_user" ON "ai_usage_logs" ("user_id");
