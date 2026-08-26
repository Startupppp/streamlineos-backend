-- 0502 — platform subscription cutover: keyset cursor index (c26-06)
-- =============================================================================
-- Ticket: c26-06 (one subscription table feeds billing and platform administration)
--
-- RECONCILIATION (expand/reconcile/cutover/contract — reconcile step)
-- Confirmed: platform_subscriptions has no application writer. Every INSERT,
-- UPDATE and DELETE path in the codebase writes only to the canonical
-- subscriptions table. Any rows in platform_subscriptions are historical stale
-- data from a pre-migration seed; the count of unexplained differences is zero.
--
-- CUTOVER (code)
-- platform.service.ts listCustomers() and getCustomerBySlug() now read from
-- subscriptions (canonical) instead of platform_subscriptions (shadow).
-- The correlated-subquery per-org member count and lifetime revenue have been
-- replaced with a single batch aggregate + in-memory merge over the 100-row page.
-- listCustomers() requires a keyset cursor (afterCreatedAt + afterId) and is
-- hard-capped at 100 rows per page; it never returns every organisation.
--
-- CONTRACT (future)
-- The DROP TABLE platform_subscriptions migration ships separately after the
-- old-table read count reaches zero in production monitoring.
--
-- INDEX
-- Supports efficient keyset cursor seeks: WHERE (created_at < :ts) OR
-- (created_at = :ts AND id < :id) ORDER BY created_at DESC, id DESC LIMIT 101.
-- Organizations carries no RLS policy (global table), so a plain CREATE INDEX
-- is sufficient. For a table with heavy write load, prefer CONCURRENTLY outside
-- a migration transaction — see 0374_build_partial_indexes.sql for the pattern.
-- =============================================================================

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_organizations_created_cursor
  ON organizations (created_at DESC, id DESC);
