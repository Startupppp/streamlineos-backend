-- KB review fixes: follows 0118_kb_foundations. Apply AFTER the Drizzle schema changes are
-- pushed (`pnpm db:push` / `db:migrate`). These statements bring the live indexes in line with
-- the updated kb.ts / events.ts schema (space-scoped category slugs, feedback dedup target,
-- analytics event lookup, and article sort indexes) and are idempotent / safe to re-run.

-- 1. Category slug uniqueness is now space-scoped, matching the backend per-space clash check.
--    Dropping the old (org_id, slug) unique index assumes no existing rows violate the new
--    (org_id, space_id, slug) uniqueness — they won't, since slug was previously unique per org,
--    which is strictly stronger than per (org, space).
DROP INDEX IF EXISTS "uniq_kb_categories_org_slug";
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_categories_org_space_slug" ON "kb_categories" ("org_id","space_id","slug");

-- 2. Feedback dedup. Plain unique index matches the backend onConflictDoNothing target columns.
--    Postgres treats NULL visitor_id as distinct, so anonymous feedback is never deduped while
--    non-null visitor ids dedupe per (org, article).
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_article_feedback_org_article_visitor" ON "kb_article_feedback" ("org_id","article_id","visitor_id");

-- 3. Analytics event lookup by (org, type, time).
CREATE INDEX IF NOT EXISTS "idx_kb_events_org_type_time" ON "kb_events" ("org_id","event_type","occurred_at");

-- 4. Article sort indexes: list updatedAt sort and analytics top-articles (views desc) sort.
CREATE INDEX IF NOT EXISTS "idx_kb_articles_org_updated" ON "kb_articles" ("org_id","updated_at");
CREATE INDEX IF NOT EXISTS "idx_kb_articles_org_status_views" ON "kb_articles" ("org_id","status","views");
