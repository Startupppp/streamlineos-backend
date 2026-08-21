-- Rollback for 0424. Fully reversible: drops the search helper.
-- Callers fall back to the plain ILIKE path, which is correct but seq-scans (see 0424's header).
DROP FUNCTION IF EXISTS app.search_ticket_ids(text);
