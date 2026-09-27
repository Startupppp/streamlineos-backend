-- Rollback 1377: drop the mention user search function.
-- Callers fall back to the leading-wildcard ILIKE path (which sequential-scans org members).
-- The GIN indexes idx_users_email_trgm and idx_users_name_trgm are retained: they were created
-- by migration 0007, not by 1377, so they are not this rollback's to drop.

DROP FUNCTION IF EXISTS app.search_mention_user_ids(text[]);
