SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 1061 — release a browser push endpoint held by ANOTHER tenant, so re-registering
--        a browser stops answering 500.
--
-- Same shape, and the same reason, as 0385/0386/0387/1057: a statement that must
-- cross a tenant boundary, narrowed to exactly the rows it needs and nothing else.
--
-- WHAT WAS WRONG. `push_subscriptions.endpoint` carries a GLOBAL unique constraint
-- (`push_subscriptions_endpoint_unique`, total, no predicate) while the table's RLS
-- policy is per-tenant: `USING (org_id = app.current_org_id())`. Those two facts
-- cannot both be honoured by any statement the app role can write. Measured against
-- scratch_head_1010 as `streamline_app`, rolled back:
--
--   set app.organization_id = 'A';  insert endpoint E owned by A          -- ok
--   set app.organization_id = 'B';  select … where endpoint = E           -- 0 rows
--   set app.organization_id = 'B';  insert … on conflict (endpoint) do update
--     ERROR:  new row violates row-level security policy (USING expression)
--             for table "push_subscriptions"                              -- 42501
--
-- So once a browser has registered against one tenant, `POST /push/subscribe` from
-- that same browser in any other tenant is a deterministic 500 — and a plain DELETE
-- first does not help, because RLS hides the row from the DELETE too (0 rows). The
-- invariant `web-push.service.ts:53-57` states, "a person in two organizations has a
-- subscription row per organization", is unreachable from the application role.
--
-- WHY A RESOLVER AND NOT A POLICY ARM. Widening `tenant_isolation` with an
-- endpoint-keyed arm would grant read of the FULL row — `p256dh` and `auth`, the
-- keys that encrypt that browser's payloads — to every existing and future
-- endpoint-keyed query against this table. This function reads nothing back: it
-- deletes rows for one endpoint that belong to some OTHER tenant and returns how
-- many. It cannot touch the caller's own tenant (that is the upsert's job, under
-- live RLS), it cannot enumerate, and it cannot disclose.
--
-- WHY THIS IS NOT A NEW CAPABILITY. `endpoint` is a high-entropy URL minted by the
-- browser's push service and known only to that browser and this server. A caller
-- who can present one already holds the browser; before this migration the same
-- caller could take the subscription over within their own tenant (that is the
-- other half of the P0 this fixes). What changes is that taking a browser over now
-- also releases the stale registration another tenant is still pushing to, instead
-- of leaving it delivering that tenant's notifications to whoever now holds the
-- browser.
--
-- It raises rather than guesses when there is no tenant context: `app.current_org_id()`
-- RAISES 42501 when `app.organization_id` is unset, so an untenanted caller cannot
-- use this to clear an endpoint globally.

CREATE OR REPLACE FUNCTION app.claim_push_endpoint(p_endpoint text) RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  released integer;
  caller text := app.current_org_id();
BEGIN
  IF p_endpoint IS NULL OR length(p_endpoint) = 0 THEN
    RETURN 0;
  END IF;

  DELETE FROM push_subscriptions
   WHERE endpoint = p_endpoint
     AND org_id IS DISTINCT FROM caller;

  GET DIAGNOSTICS released = ROW_COUNT;
  RETURN released;
END
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.claim_push_endpoint(text) IS
  'Releases push_subscriptions rows for one browser endpoint that belong to a tenant other than the caller''s, and returns how many. Bypasses RLS for that delete alone so a browser re-registering in a second organisation stops raising 42501 against the global unique on endpoint. Returns no row data. Never widen this to read or to touch the caller''s own tenant: the caller''s row is re-owned by the upsert, under live RLS.';
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.claim_push_endpoint(text) FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE
  app_role text := coalesce(current_setting('app.bootstrap_role', true), 'streamline_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.claim_push_endpoint(text) TO %I', app_role);
  END IF;
END $$;
--> statement-breakpoint

-- Read the catalog back rather than trusting completion: db:migrate reports success
-- over a statement that did nothing.
DO $$
DECLARE
  secdef boolean;
BEGIN
  SELECT p.prosecdef INTO secdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app' AND p.proname = 'claim_push_endpoint';

  IF secdef IS NULL THEN
    RAISE EXCEPTION '1061: app.claim_push_endpoint does not exist after this migration';
  END IF;
  IF NOT secdef THEN
    RAISE EXCEPTION '1061: app.claim_push_endpoint is not SECURITY DEFINER, so it cannot cross the tenant boundary';
  END IF;
END
$$;
