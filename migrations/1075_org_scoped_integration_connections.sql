-- 1075 — one shared integration account per organisation per toolkit, enforced in the database.
--
-- WHY. `user_integration_connections.scope` has carried `'user' | 'org'` since 0000 and nothing
-- ever wrote `'org'`; `IntegrationsService.finalize` hardcodes `'user'`. The org case now exists
-- so a huddle can mint a Google Meet link for a member who has connected nothing of their own:
-- `resolveToolkitConnection` prefers the caller's own active connection and falls back to the
-- org-scoped one. That fallback has to be single-valued — two org rows for `googlecalendar`
-- means the account a huddle lands in depends on row order, which is not a property the
-- application can restore after the fact. `OrgConnectionsService.replace` deletes the incumbent
-- inside the same transaction as the insert, so the only way to reach this index is two admins
-- finalising concurrently; that raises 23505 and the service answers 409.
--
-- SHAPE. Partial on `scope = 'org'`, so the millions of personal rows are neither indexed nor
-- constrained by it — a member keeps as many personal Gmail and Calendar connections as they
-- like. `org_id` LEADS: this table carries RLS (its policy is `org_id = app.current_org_id()`,
-- see 1057), the qual is not leakproof, and the planner will not consider an index that does
-- not supply `org_id` itself.
--
-- LOCKING. Not CONCURRENTLY: the migration runner wraps each file in a transaction, where
-- CONCURRENTLY is rejected outright, and the predicate selects zero rows today because no
-- `'org'` row exists anywhere — the build is a scan of an empty partial set. `lock_timeout`
-- keeps the SHARE lock from queueing in front of the connection reads on the calendar and mail
-- paths.
--
-- NOT BACKFILLED and NOT a data migration: `scope` already defaults to `'user'` NOT NULL, so
-- every existing row is outside the predicate and this can never fail on data.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_integration_connections_org_scoped_toolkit"
  ON "user_integration_connections" ("org_id", "toolkit")
  WHERE "scope" = 'org';
--> statement-breakpoint

-- Read the catalog back: db:migrate reports success over an IF NOT EXISTS that did nothing.
DO $$
DECLARE
  idx_def text;
  idx_unique boolean;
  idx_pred text;
BEGIN
  SELECT pg_get_indexdef(x.indexrelid), x.indisunique, pg_get_expr(x.indpred, x.indrelid)
    INTO idx_def, idx_unique, idx_pred
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
   WHERE i.relname = 'uq_integration_connections_org_scoped_toolkit'
     AND x.indrelid = 'user_integration_connections'::regclass;
  IF NOT FOUND THEN
    RAISE EXCEPTION '1075: uq_integration_connections_org_scoped_toolkit was not created';
  END IF;
  IF NOT idx_unique THEN
    RAISE EXCEPTION '1075: uq_integration_connections_org_scoped_toolkit is not UNIQUE — a second org connection would be accepted silently';
  END IF;
  IF idx_pred IS NULL OR position('org' in idx_pred) = 0 THEN
    RAISE EXCEPTION '1075: uq_integration_connections_org_scoped_toolkit lost its scope = org predicate — it would now block a member''s second personal connection (%)', coalesce(idx_pred, 'none');
  END IF;
  IF position('(org_id' in idx_def) = 0 THEN
    RAISE EXCEPTION '1075: uq_integration_connections_org_scoped_toolkit does not lead with org_id — unusable under this table''s RLS policy (%)', idx_def;
  END IF;
END
$$;
