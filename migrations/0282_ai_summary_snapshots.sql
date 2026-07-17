-- DO NOT APPLY MANUALLY: managed by Drizzle migrate
-- Phase 0.6: AI summary snapshots table

CREATE TABLE "ai_summary_snapshots" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "entity_type" varchar(50) NOT NULL,
  "entity_id" varchar(100) NOT NULL,
  "summary" text NOT NULL,
  "structured" jsonb,
  "citations" jsonb,
  "correlation_id" varchar(64),
  "generated_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX "idx_ai_summary_snapshots_org_type_entity_created"
  ON "ai_summary_snapshots" ("org_id", "entity_type", "entity_id", "created_at");
