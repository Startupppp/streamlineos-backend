SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  t text;
  targets text[] := ARRAY[
    'inv_asn_lines',
    'inv_asns',
    'inv_channel_pools',
    'inv_dock_appointments',
    'inv_dock_doors',
    'inv_handling_units',
    'inv_kit_components',
    'inv_labor_records',
    'inv_platform_payout_lines',
    'inv_platform_po_lines',
    'inv_platform_purchase_orders',
    'inv_slotting_recommendations',
    'inv_slotting_rules',
    'inv_velocity_classes',
    'operator_access_grants',
    'operator_access_log'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE EXCEPTION '0768: table public.% does not exist', t;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = format('public.%I', t)::regclass
        AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped
    ) THEN
      RAISE EXCEPTION '0768: table public.% has no org_id column', t;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = format('public.%I', t)::regclass AND p.polname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I FOR ALL USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id())',
        t
      );
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY(targets)
      AND (NOT c.relrowsecurity
        OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))
  ) THEN
    RAISE EXCEPTION '0768: at least one target still lacks RLS or a policy';
  END IF;
END $$;
