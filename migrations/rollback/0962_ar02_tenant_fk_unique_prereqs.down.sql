-- 0962_ar02_tenant_fk_unique_prereqs DOWN — reverses the up migration; each restored constraint is rebuilt from the definition recorded in pg_catalog before it was dropped.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.operator_access_grants DROP CONSTRAINT IF EXISTS "operator_access_grants_org_id_grant_id_uniq";
--> statement-breakpoint
ALTER TABLE public.principal_groups DROP CONSTRAINT IF EXISTS "principal_groups_org_id_id_uniq";
--> statement-breakpoint
ALTER TABLE public.coupons DROP CONSTRAINT IF EXISTS "coupons_org_id_id_uniq";
