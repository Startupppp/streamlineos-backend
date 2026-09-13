SET lock_timeout = '5s';

ALTER TABLE public.fin_expense_policies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.fin_expense_policies;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.fin_expense_policies
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.fin_reimbursement_batches;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.fin_reimbursement_batches
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
