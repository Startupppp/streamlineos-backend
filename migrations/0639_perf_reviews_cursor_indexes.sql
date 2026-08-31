-- Keyset indexes for the HR performance review list (org_id leads: the RLS policy predicates on it).

CREATE INDEX IF NOT EXISTS "idx_perf_reviews_org_created_id"
  ON "performance_reviews" ("org_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "idx_perf_reviews_org_user_created_id"
  ON "performance_reviews" ("org_id", "user_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "idx_perf_reviews_org_period_start_id"
  ON "performance_reviews" ("org_id", "period_start" DESC, "id" DESC);
