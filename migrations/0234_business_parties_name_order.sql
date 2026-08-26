-- 0234: the contact list's ordering, moved onto Party.
--
-- Phase 2 ticket 06 moves `contacts` reads onto `contact_party_map ⨝
-- business_parties`, and the contact list has always been ordered by name and
-- paged by offset. On the legacy table that read was served by
-- `idx_contacts_name_email (org_id, name, email)`; on the party side nothing
-- leads with `(organization_id, name)`, so the same list would sort the whole
-- tenant on every page. This is that index, on the table the read moved to.
--
-- The client list orders by name too and never had an index for it, so it gains
-- one here rather than being left as the slower of the two.
--
-- `party_id` is the third column, not decoration: it is what makes the index
-- cover the join back to the map, and every useful index on this table under RLS
-- has to carry `organization_id` itself — the policy's `organization_id =
-- app.current_org_id()` is not leakproof, so it is checked against the heap
-- tuple and an index that omits the column cannot produce an index-only scan.
--
-- Partial on `deleted_at IS NULL` because every list read filters it, and the
-- partial index stays a fraction of the table.
--
-- Not CONCURRENTLY: `db:migrate` runs each file in a transaction, where
-- CONCURRENTLY is not allowed. `lock_timeout` is what stops a build queueing
-- behind a long reader and blocking every write to `business_parties` behind it.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_business_parties_org_name"
  ON "business_parties" ("organization_id", "name", "party_id")
  WHERE "deleted_at" IS NULL;

--> statement-breakpoint
ANALYZE "business_parties";
