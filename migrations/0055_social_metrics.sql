CREATE TABLE IF NOT EXISTS "social_metrics" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "platform" text NOT NULL,
  "metric_date" date NOT NULL,
  "followers" integer DEFAULT 0,
  "impressions" integer DEFAULT 0,
  "engagements" integer DEFAULT 0,
  "clicks" integer DEFAULT 0,
  "shares" integer DEFAULT 0,
  "comments" integer DEFAULT 0,
  "reach" integer DEFAULT 0,
  "recorded_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "social_metrics_org_platform_idx" ON "social_metrics"("org_id", "platform");
CREATE INDEX IF NOT EXISTS "social_metrics_date_idx" ON "social_metrics"("metric_date");
