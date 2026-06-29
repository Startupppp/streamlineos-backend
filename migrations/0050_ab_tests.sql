CREATE TABLE IF NOT EXISTS "ab_tests" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "status" text DEFAULT 'draft',
  "variant_a_subject" text NOT NULL,
  "variant_b_subject" text NOT NULL,
  "variant_a_body" text,
  "variant_b_body" text,
  "split_percent" integer DEFAULT 50,
  "audience_size" integer DEFAULT 0,
  "variant_a_sent" integer DEFAULT 0,
  "variant_b_sent" integer DEFAULT 0,
  "variant_a_opens" integer DEFAULT 0,
  "variant_b_opens" integer DEFAULT 0,
  "variant_a_clicks" integer DEFAULT 0,
  "variant_b_clicks" integer DEFAULT 0,
  "winner_variant" text,
  "started_at" timestamp,
  "ended_at" timestamp,
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ab_tests_org_id_idx" ON "ab_tests"("org_id");
CREATE INDEX IF NOT EXISTS "ab_tests_status_idx" ON "ab_tests"("status");
