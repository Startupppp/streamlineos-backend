-- The last three org-bearing tables in the catalog with no index, primary key or
-- unique constraint leading on their tenant column. Under RLS the policy predicate
-- org_id = app.current_org_id() is not leakproof, so an index that cannot supply the
-- tenant column is refused and the read degrades to a sequential scan of every
-- organisation's rows. Ticket 03 measured the difference as streamline_app with the
-- GUC set over 50,000 rows across 20 organisations: 516 shared buffers on a Seq Scan
-- with 47,500 rows removed by filter, against 4 hit + 2 read on an Index Scan with
-- (org_id, created_at). The gap grows with the number of organisations, not the
-- number of rows one organisation owns.
--
-- support_ticket_tags additionally carries org_id and a composite FK to
-- support_tickets (org_id, ticket_id) that no index leads, so the referential check
-- and OrgPurgeService's cascade both scan it.
--
-- Plain CREATE INDEX rather than CONCURRENTLY: all three are small, and
-- db-bootstrap.mjs applies each statement on an autocommit connection where the
-- CONCURRENTLY special case is a separate path.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_communication_backfill_issues_org_created
  ON public.communication_backfill_issues (org_id, created_at DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_subprocessor_subscribers_org_created
  ON public.subprocessor_subscribers (organization_id, created_at DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_support_ticket_tags_org_ticket
  ON public.support_ticket_tags (org_id, ticket_id);
