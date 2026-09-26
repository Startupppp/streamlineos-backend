-- Rollback for 1218_kb_ai_interactions_research_brief
-- Drops the research-brief FK, its index and the research_brief_id column.
-- kb_ai_interactions itself is untouched — 1208 owns that table's lifecycle.
SET lock_timeout = '5s';

ALTER TABLE "public"."kb_ai_interactions" DROP CONSTRAINT IF EXISTS "fk_kb_ai_interactions_org_research_brief";

DROP INDEX IF EXISTS "public"."idx_kb_ai_interactions_org_research_brief";

ALTER TABLE "public"."kb_ai_interactions" DROP COLUMN IF EXISTS "research_brief_id";
