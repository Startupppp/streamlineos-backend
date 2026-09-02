-- 0994 DOWN — drops the tenant-isolation policies and disables RLS, returning the
-- sixteen inventory tables to org-wide readability for anyone holding the app grant.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_ai_feedback;
--> statement-breakpoint
ALTER TABLE public.inv_ai_feedback DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_allocation_overrides;
--> statement-breakpoint
ALTER TABLE public.inv_allocation_overrides DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_audit_export_jobs;
--> statement-breakpoint
ALTER TABLE public.inv_audit_export_jobs DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_channel_snapshot_diffs;
--> statement-breakpoint
ALTER TABLE public.inv_channel_snapshot_diffs DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_channel_webhook_deliveries;
--> statement-breakpoint
ALTER TABLE public.inv_channel_webhook_deliveries DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_customer_shelf_life_rules;
--> statement-breakpoint
ALTER TABLE public.inv_customer_shelf_life_rules DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_demand_forecasts;
--> statement-breakpoint
ALTER TABLE public.inv_demand_forecasts DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_grn_line_serials;
--> statement-breakpoint
ALTER TABLE public.inv_grn_line_serials DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_inspection_plan_versions;
--> statement-breakpoint
ALTER TABLE public.inv_inspection_plan_versions DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_inspection_plans;
--> statement-breakpoint
ALTER TABLE public.inv_inspection_plans DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_landed_cost_allocations;
--> statement-breakpoint
ALTER TABLE public.inv_landed_cost_allocations DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_landed_cost_charges;
--> statement-breakpoint
ALTER TABLE public.inv_landed_cost_charges DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_landed_cost_vouchers;
--> statement-breakpoint
ALTER TABLE public.inv_landed_cost_vouchers DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_proposal_overrides;
--> statement-breakpoint
ALTER TABLE public.inv_proposal_overrides DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_putaway_task_lines;
--> statement-breakpoint
ALTER TABLE public.inv_putaway_task_lines DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_putaway_tasks;
--> statement-breakpoint
ALTER TABLE public.inv_putaway_tasks DISABLE ROW LEVEL SECURITY;
