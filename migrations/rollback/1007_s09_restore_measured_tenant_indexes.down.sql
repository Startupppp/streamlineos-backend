-- 1007 DOWN -- drops the seven measured tenant indexes again, returning the catalog to
-- 0999's shape. Reverting this re-introduces the six sequential scans 1007 documents;
-- it exists for chain symmetry, not because the drop is a good idea.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS public.idx_contacts_org;
--> statement-breakpoint

DROP INDEX IF EXISTS public.idx_inv_stock_org;
--> statement-breakpoint

DROP INDEX IF EXISTS public.idx_hr_people_org;
--> statement-breakpoint

DROP INDEX IF EXISTS public.idx_chat_channel_members_org;
--> statement-breakpoint

DROP INDEX IF EXISTS public.idx_org_people_org;
--> statement-breakpoint

DROP INDEX IF EXISTS public.idx_inv_locations_org;
--> statement-breakpoint

DROP INDEX IF EXISTS public.idx_inv_txn_org_variant;
