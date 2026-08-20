-- 0434: index-backed chat message search under RLS.
--
-- chat-search.service.ts matched with a leading-wildcard ILIKE and no supporting index, so every
-- search was a sequential scan of chat_messages. A plain GIN trigram index does not fix this on
-- its own: search operators are not leakproof, so under an RLS security qual they can never become
-- an index condition. ALTER FUNCTION ... LEAKPROOF is impossible on Neon (no true superuser).
--
-- Same escape as tickets (0424/0425): a SECURITY DEFINER function owned by the BYPASSRLS role,
-- with the same five safety properties -- org comes from app.current_org_id() and never from a
-- parameter (fails closed 42501 with no GUC), it returns ids only and never row content, the
-- caller's own query still runs under RLS and still applies the channel-membership predicate,
-- EXECUTE is revoked from PUBLIC, and it takes a limit so the caller can detect an over-broad
-- term and fall back to plain ILIKE -- which is the faster plan in exactly that case.
--
-- The index is created non-concurrently because chat_messages is empty. If this is ever applied
-- to a populated database, build it CONCURRENTLY outside the migration transaction first.
CREATE INDEX IF NOT EXISTS "idx_chat_messages_content_trgm"
  ON "chat_messages" USING gin ("content" gin_trgm_ops);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_chat_message_ids(p_q text, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT m.id
  FROM public.chat_messages m
  WHERE m.org_id = app.current_org_id()
    AND m.is_deleted = false
    AND m.content ILIKE '%' || p_q || '%'
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_chat_message_ids(text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_chat_message_ids(text, integer) TO streamline_app;
