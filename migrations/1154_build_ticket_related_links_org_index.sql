-- 1154 — org-led index on build.ticket_related_links.
-- Rollback: migrations/rollback/1154_build_ticket_related_links_org_index.down.sql
--
-- listRelatedLinks (projects-ticket-links.service.ts:110) is the one Build read whose
-- WHERE carries no org_id:
--
--   .from(ticketRelatedLinks).where(eq(ticketRelatedLinks.ticketId, ticketId))
--
-- That is not a tenant leak. assertTicketAccess runs first and 404s a ticket outside the
-- caller's org, and RLS fences the table independently. It is a plan cost: the only index
-- is idx_ticket_related_links_ticket on (ticket_id) alone, so with org_id absent from
-- both the query and the index, BE-79 means every candidate row is heap-fetched to
-- evaluate app.current_org_id() and no index-only scan is possible.
--
-- This index is half the fix. The other half is the org_id predicate in the query, which
-- lands with the service change — the index alone cannot be used for a filter the query
-- does not express.
--
-- NOT MEASURED. Per-ticket link counts are small and the read is capped at 50 rows, so
-- the expected gain is modest. Verify with EXPLAIN (ANALYZE, BUFFERS) as streamline_app
-- with the tenant GUC set (BE-76) before claiming otherwise.
--
-- No CONCURRENTLY; drizzle-kit migrate wraps this file in one transaction. Precedent 1108.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_ticket_related_links_org_ticket"
  ON "build"."ticket_related_links" ("org_id", "ticket_id", "created_at");
--> statement-breakpoint

DO $$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_indexdef(x.indexrelid) INTO definition
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
   WHERE i.relname = 'idx_ticket_related_links_org_ticket'
     AND x.indrelid = 'build.ticket_related_links'::regclass;
  IF definition IS NULL THEN
    RAISE EXCEPTION '1154: idx_ticket_related_links_org_ticket was not created';
  END IF;
  IF definition NOT LIKE '%org_id, ticket_id, created_at%' THEN
    RAISE EXCEPTION '1154: wrong column order, the ordered per-ticket read is not served (%)', definition;
  END IF;
END
$$;
