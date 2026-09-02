-- Sixteen inventory tables carry a non-nullable org_id, grant streamline_app
-- SELECT/INSERT/UPDATE/DELETE, and have no row-level policy at all. Ticket 03
-- demonstrated the consequence directly rather than arguing it: as streamline_app
-- (rolbypassrls = false) with app.organization_id set to one organisation,
-- access_versions returned that organisation's single row while
-- inv_customer_shelf_life_rules returned two, the second belonging to another
-- organisation. With no GUC set at all, a policied table raises 42501 while these
-- answer normally.
--
-- The inventory module ships no service that reads them on this branch, and the
-- module is out of scope for this release. Neither fact narrows the exposure: the
-- grant is what makes a row readable, not the presence of a caller, so any raw-SQL
-- path reaches them today and every WMS service that lands later inherits an
-- already-open table. Revoking the grant instead would be undone by the
-- ALTER DEFAULT PRIVILEGES the role bootstrap re-applies, and would have to be
-- reversed the moment the services arrive; the policy is the durable answer and is
-- the shape the other 966 tenant tables already carry.
--
-- current_org_id() is schema-qualified here. The 124 unqualified references in 0619
-- only resolve because 0431 puts the app schema on neondb_owner's search_path, which
-- makes the chain depend on the name of the connecting role.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.inv_ai_feedback ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_ai_feedback;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.inv_ai_feedback
  USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE public.inv_allocation_overrides ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_allocation_overrides;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.inv_allocation_overrides
  USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE public.inv_audit_export_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_audit_export_jobs;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.inv_audit_export_jobs
  USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE public.inv_channel_snapshot_diffs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_channel_snapshot_diffs;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.inv_channel_snapshot_diffs
  USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE public.inv_channel_webhook_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_channel_webhook_deliveries;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.inv_channel_webhook_deliveries
  USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE public.inv_customer_shelf_life_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_customer_shelf_life_rules;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.inv_customer_shelf_life_rules
  USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE public.inv_demand_forecasts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_demand_forecasts;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.inv_demand_forecasts
  USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE public.inv_grn_line_serials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_grn_line_serials;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.inv_grn_line_serials
  USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE public.inv_inspection_plan_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_inspection_plan_versions;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.inv_inspection_plan_versions
  USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE public.inv_inspection_plans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_inspection_plans;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.inv_inspection_plans
  USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE public.inv_landed_cost_allocations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_landed_cost_allocations;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.inv_landed_cost_allocations
  USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE public.inv_landed_cost_charges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_landed_cost_charges;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.inv_landed_cost_charges
  USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE public.inv_landed_cost_vouchers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_landed_cost_vouchers;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.inv_landed_cost_vouchers
  USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE public.inv_proposal_overrides ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_proposal_overrides;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.inv_proposal_overrides
  USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE public.inv_putaway_task_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_putaway_task_lines;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.inv_putaway_task_lines
  USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE public.inv_putaway_tasks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.inv_putaway_tasks;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.inv_putaway_tasks
  USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
