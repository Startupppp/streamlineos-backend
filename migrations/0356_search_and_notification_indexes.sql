SET statement_timeout = 0;
-- 0356 — trigram search indexes and notifications active-inbox index
-- =============================================================================
-- Q-03: Adds a partial index on notifications(org_id, user_id, id DESC) WHERE
--       deleted_at IS NULL, matching the hot-path inbox query issued on every
--       authenticated page load.  The existing indexes on (userId, isRead,
--       createdAt), (orgId, createdAt), and (userId, archivedAt) all miss the
--       (org_id, user_id, deleted_at IS NULL) predicate or lead with userId not
--       orgId.  The partial form skips archived/deleted rows (the cold majority
--       of the table), keeping the index small and fast.
--
-- Q-04: Adds pg_trgm GIN indexes on tickets.title and leads(name, email, phone,
--       company) to replace leading-wildcard ILIKE full-scans banned by §19.
--       pg_trgm was installed on the cluster before db:migrate (prerequisite
--       documented in CLAUDE.md §19 "Migration reproducibility").
--       The leads.service.ts query is changed from LOWER(col) LIKE %lower_term%
--       to col ILIKE %term% so the indexed column expression matches exactly —
--       ILIKE on the raw column uses the gin_trgm_ops index; LOWER(col) LIKE
--       does not unless the index is defined on the expression lower(col).
--       Search semantics are preserved: ILIKE %s% is equivalent to
--       LOWER(col) LIKE LOWER(%s%) for all inputs.
-- =============================================================================

-- Q-03: notifications active-inbox hot-path index
CREATE INDEX IF NOT EXISTS idx_notifications_org_user_active
  ON notifications (org_id, user_id, id DESC)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

-- Q-04: tickets title trigram index
CREATE INDEX IF NOT EXISTS idx_tickets_title_trgm
  ON tickets USING gin (title gin_trgm_ops);
--> statement-breakpoint

-- Q-04: leads search trigram indexes
CREATE INDEX IF NOT EXISTS idx_leads_name_trgm
  ON leads USING gin (name gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_leads_email_trgm
  ON leads USING gin (email gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_leads_phone_trgm
  ON leads USING gin (phone gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_leads_company_trgm
  ON leads USING gin (company gin_trgm_ops);
