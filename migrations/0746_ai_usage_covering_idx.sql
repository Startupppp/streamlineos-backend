-- Covering index for AI usage cost aggregation queries.
-- Aggregations that filter by org_id + created_at and sum token/cost columns
-- can use an index-only scan instead of fetching heap pages for each matching row.
-- The existing idx_ai_usage_org_created(org_id, created_at) is superseded by this one.
--
-- RLS is live on ai_usage_logs (relrowsecurity = true, tenant_isolation policy).
-- org_id must lead any index on this table or RLS forces the planner to skip it.
--
-- Not CONCURRENTLY: db:migrate wraps each file in a transaction and CONCURRENTLY is
-- rejected inside one (same reasoning as 0674/0475/0497).
--
-- lock_timeout: 5s — fails fast rather than queueing behind long reads.

SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ai_usage_org_created_cover
    ON ai_usage_logs (org_id, created_at)
    INCLUDE (credits_milli, estimated_cost_usd, total_tokens, prompt_tokens, completion_tokens, feature, model);
--> statement-breakpoint
-- Superfluous after the covering index above because every query that used the old
-- index now has a strictly-better one. Drop avoids write-amplification maintaining two
-- entries with the same leading columns.
DROP INDEX IF EXISTS idx_ai_usage_org_created;
