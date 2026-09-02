-- 0997 DOWN — removes the eight read-path indexes.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS public.idx_org_units_org_kind_live;
--> statement-breakpoint
DROP INDEX IF EXISTS public.idx_org_units_org_kind_active;
--> statement-breakpoint
DROP INDEX IF EXISTS public.idx_acc_tax_payments_org_live_id;
--> statement-breakpoint
DROP INDEX IF EXISTS public.idx_acc_tax_payments_org_live_created;
--> statement-breakpoint
DROP INDEX IF EXISTS public.idx_organization_people_live_lookup;
--> statement-breakpoint
DROP INDEX IF EXISTS public.idx_worker_engagements_org_worker_live;
--> statement-breakpoint
DROP INDEX IF EXISTS public.idx_hr_wf_def_lineage_live;
--> statement-breakpoint
DROP INDEX IF EXISTS public.idx_role_permission_grants_org_key;
