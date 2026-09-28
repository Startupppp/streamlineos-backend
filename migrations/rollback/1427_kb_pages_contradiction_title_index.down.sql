-- Rollback for 1427_kb_pages_contradiction_title_index.sql
DROP INDEX IF EXISTS "public"."idx_kb_pages_org_space_title_lower_published";
