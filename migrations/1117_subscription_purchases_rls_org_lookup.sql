SET lock_timeout = '5s';

-- SECURITY DEFINER helper that resolves the owning org for a provider order id without
-- a tenant GUC.  The webhook endpoint is @Public() so no ambient transaction is open;
-- enabling RLS alone would make the mismatch guard in billing-webhook.handler.ts:settle()
-- unreachable (the row would be filtered before the comparison fires, silently attaching
-- another tenant's payment to the wrong org).  A SECURITY DEFINER function owned by the
-- BYPASSRLS role is the safe escape: the caller gains only the org_id UUID and nothing
-- else; it never receives row data.  The billing handler then uses the returned org_id to
-- drive the mismatch check and — if the org matches — re-reads the full row inside a
-- runInNewTenantTransaction (under live RLS) before passing it downstream.
--
-- Why the order id is a parameter here but the ticket-search function takes the org from
-- app.current_org_id() instead: the ticket search is always scoped to the current tenant,
-- so accepting an org parameter would let any caller read any org's tickets.  This lookup
-- is deliberately cross-tenant: its entire purpose is to determine which org owns the
-- order, so the mismatch guard can compare that against the claimed org.  The parameter is
-- a provider-assigned order id (not an org id), and the function returns only a single org
-- id UUID — no financial data, no purchase details.
CREATE OR REPLACE FUNCTION app.subscription_purchase_org_for_order(p_provider_order_id text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT org_id
  FROM public.subscription_purchases
  WHERE provider_order_id = p_provider_order_id
  LIMIT 1
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.subscription_purchase_org_for_order(text) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.subscription_purchase_org_for_order(text) TO streamline_app;
--> statement-breakpoint

ALTER TABLE public.subscription_purchases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON public.subscription_purchases;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.subscription_purchases
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
