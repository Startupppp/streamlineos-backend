-- Rollback for 1208_kb_ai_interactions
-- Drops the kb_ai_interactions table and all its constraints, indexes and policies.
SET lock_timeout = '5s';

DROP TABLE IF EXISTS "public"."kb_ai_interactions";
