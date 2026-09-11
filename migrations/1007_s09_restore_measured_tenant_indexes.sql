-- Forward correction to 0999. Seven narrow tenant indexes it dropped as a "leading
-- prefix" of a wider surviving index are restored, because prefix containment
-- proves REACHABILITY, not COST.
--
-- 0999's argument was structural: a btree on (org_id, a, b) can answer every
-- predicate a btree on (org_id) can, so the narrow one is redundant. That is true
-- of what the planner CAN do and false of what it WILL do. The surviving index is
-- physically larger -- idx_contacts_name_email is 1,968 kB against a 1,720 kB heap,
-- larger than the table it indexes -- so for a tenant holding most of the rows the
-- planner costs the wide index above a sequential scan and takes the scan.
--
-- Measured on the seeded four-tenant database as the non-owner application role,
-- each index recreated inside a rolled-back transaction so the comparison is
-- same-session, same-cache, same-statistics. Buffers, dropped -> restored:
--
--   contacts               645 -> 30   (survivor idx_contacts_name_email)
--   inv_stock_levels       609 -> 39   (survivor uniq_inv_stock_levels_natural_key)
--   hr_people              306 -> 24   (survivor uniq_hr_people_org_id)
--   chat_channel_members   108 -> 12   (survivor idx_chat_channel_members_org_membership)
--   organization_people     39 -> 6    (survivor uniq_org_people_org_person)
--   inv_locations           18 -> 4    (survivor uniq_inv_locations_org_id)
--   inv_stock_transactions  30 -> 12   (survivor idx_inv_txn_org_variant_type_created)
--
-- inv_stock_levels is the literal query at inventory/settings/settings.service.ts:137.
--
-- The seventh, inv_stock_transactions, surfaced only on the re-run AFTER the first six
-- were restored, and it is a different shape: both plans are index scans, so this is not
-- a sequential-scan fallback but a density difference. (org_id, product_variant_id) is a
-- 2-column btree; the survivor is a 17 MB 4-column btree over a 28 MB heap, so it fits
-- far fewer tuples per leaf page and the same equality lookup touches 30 buffers instead
-- of 12. It is flat on the three minority tenants. Restored because the measurement says
-- so, and recorded here as a smaller effect than the other six rather than lumped in.
--
-- Every one of the six is FLAT on the minority tenants and only regresses on the
-- majority tenant, so a single-tenant or unseeded database cannot see it: with one
-- distinct org_id the tenant column discriminates nothing and an org-leading index
-- reads as strictly redundant. That is why 0999 was measured wrong rather than
-- reasoned wrong, and it is the reason the other 348 drops are NOT reverted here --
-- 7 of them are confirmed redundant and 319 are simply unqueried by this seed, which
-- is an absence of evidence, not evidence of safety.
--
-- hr_people already carries idx_hr_people_org_live (org_id) WHERE deleted_at IS NULL.
-- That partial index cannot serve a query that does not repeat its predicate, which
-- is why the unconditional (org_id) index is still needed beside it.
--
-- CREATE INDEX rather than CREATE INDEX CONCURRENTLY: drizzle-kit migrate wraps a
-- migration in a transaction and rejects CONCURRENTLY outright (check:migration-
-- discipline rule 7). lock_timeout bounds the lock wait instead.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_contacts_org ON public.contacts USING btree (org_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_inv_stock_org ON public.inv_stock_levels USING btree (org_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_hr_people_org ON public.hr_people USING btree (org_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_chat_channel_members_org ON public.chat_channel_members USING btree (org_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_org_people_org ON public.organization_people USING btree (organization_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_inv_locations_org ON public.inv_locations USING btree (org_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_inv_txn_org_variant ON public.inv_stock_transactions USING btree (org_id, product_variant_id);
--> statement-breakpoint

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(want.name, ', ' ORDER BY want.name)
    INTO missing
    FROM (VALUES
            ('idx_contacts_org'),
            ('idx_inv_stock_org'),
            ('idx_hr_people_org'),
            ('idx_chat_channel_members_org'),
            ('idx_org_people_org'),
            ('idx_inv_locations_org'),
            ('idx_inv_txn_org_variant')) AS want(name)
   WHERE NOT EXISTS (
           SELECT 1 FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'i' AND n.nspname = 'public' AND c.relname = want.name);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'measured tenant indexes were not restored: %', missing;
  END IF;
END $$;
