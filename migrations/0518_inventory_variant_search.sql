SET lock_timeout = '5s';
--> statement-breakpoint
-- INV-110. Three inventory list queries filter with a leading-wildcard ILIKE
-- against inv_products and inv_product_variants — the stock list, its count, and
-- the movement history, which the PRD targets at 10 million rows per tenant.
--
-- The trigram indexes for these columns already exist. They are unusable from
-- the application role: the policy adds org_id = app.current_org_id(), which is
-- not leakproof, so the planner may not run the user qual before the RLS qual
-- and skips the index. ALTER FUNCTION ... LEAKPROOF is impossible on Neon — no
-- true superuser — so the escape is a SECURITY DEFINER function owned by the
-- BYPASSRLS owner, which runs outside the security barrier.
--
-- The five conditions that make that safe, all present here and all load-bearing:
--   the organisation comes from app.current_org_id(), never a parameter, so it
--     fails closed with 42501 when the GUC is absent;
--   it returns ids only, never rows;
--   the caller's own query still runs under RLS with its own scope;
--   EXECUTE is revoked from PUBLIC and granted only to the application role;
--   it takes a LIMIT, so the set-returning function is never materialised whole.
CREATE OR REPLACE FUNCTION app.search_inventory_variant_ids(p_q text, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT v.id
  FROM public.inv_product_variants v
  JOIN public.inv_products p ON p.id = v.product_id
  WHERE p.org_id = app.current_org_id()
    AND v.org_id = app.current_org_id()
    AND p.deleted_at IS NULL
    AND v.deleted_at IS NULL
    AND (p.name ILIKE '%' || p_q || '%'
      OR p.sku ILIKE '%' || p_q || '%'
      OR v.sku ILIKE '%' || p_q || '%'
      OR v.barcode ILIKE '%' || p_q || '%')
  LIMIT p_limit
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.search_inventory_variant_ids(text, integer) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'streamline_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.search_inventory_variant_ids(text, integer) TO streamline_app';
  END IF;
END $$;
--> statement-breakpoint
-- inv_product_variants.barcode has no trigram index; the other three columns do.
CREATE INDEX IF NOT EXISTS "idx_inv_variants_barcode_trgm"
  ON "inv_product_variants" USING gin ("barcode" gin_trgm_ops);
