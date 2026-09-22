SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 1135 — resolve the org id for an inbound CRM mailbox push notification.
--
-- Same shape, and the same reason, as 0385/0386/0387 and 1057.
--
-- POST /crm/mailboxes/push is @Public(): a Gmail or Outlook change notification
-- carries no session, so TenantContextInterceptor opens no tenant transaction and
-- `createTenantAwareDb` falls through to the raw pool with `app.organization_id`
-- unset. `crm_mailbox_sync` is behind `organization_id = app.current_org_id()`
-- (0231), and that function RAISES 42501 when the GUC is unset rather than
-- returning NULL — so the lookup that decides WHICH TENANT the delivery belongs to
-- could not run at all, and every well-formed, correctly signed delivery answered
-- HTTP 500. The provider retried, got 500 again, and no pushed mail ever reached
-- the CRM ingress for any tenant.
--
-- Widening the table's own policy with an address-keyed arm was rejected for the
-- reason 0387's header already states: a policy arm grants read of the FULL row to
-- every existing and future address-only query against this table, and this table
-- holds `push_secret` — the key the notification signature is verified against.
-- Handing that to an untenanted caller would let anyone who can guess a mailbox
-- address read the secret they would need to forge a delivery for it. The SECURITY
-- DEFINER resolver keeps the bypass to the single column the tenant lookup actually
-- needs. The mailbox row itself, `push_secret` included, is re-read by the caller
-- inside `runInNewTenantTransaction(orgId, …)`, under live RLS, where the
-- `enabled = true` and provider/address predicate is enforced against the real row.

CREATE OR REPLACE FUNCTION app.resolve_crm_mailbox_sync_org_id(p_provider text, p_address text) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT organization_id
  FROM crm_mailbox_sync
  WHERE provider = p_provider
    AND mailbox_address = p_address
    AND enabled = true
  LIMIT 1;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.resolve_crm_mailbox_sync_org_id(text, text) IS
  'Returns only the organization_id for an enabled CRM mailbox, bypassing RLS for that single column so an inbound mailbox push notification can resolve its tenant before it holds one. Never expose any other column through this path (esp. push_secret); the mailbox row is re-read under RLS inside the tenant transaction.';
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.resolve_crm_mailbox_sync_org_id(text, text) FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE
  app_role text := coalesce(current_setting('app.bootstrap_role', true), 'streamline_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.resolve_crm_mailbox_sync_org_id(text, text) TO %I', app_role);
  END IF;
END $$;
