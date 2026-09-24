-- Rollback for migration 1154.
-- Drops the org-led composite index on build.ticket_related_links. The pre-existing
-- idx_ticket_related_links_ticket on (ticket_id) was never touched and still serves the
-- read. No data is lost.
--
-- If the service change that adds the org_id predicate has already shipped, rolling this
-- back leaves that predicate without a supporting index — correct, but slower than
-- before the pair landed.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_ticket_related_links_org_ticket";
