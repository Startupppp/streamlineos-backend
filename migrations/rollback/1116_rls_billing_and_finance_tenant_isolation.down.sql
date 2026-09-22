-- Rollback for 1116_rls_billing_and_finance_tenant_isolation.
--
-- The forward migration enabled RLS and created tenant_isolation policies on
-- fin_expense_policies and fin_reimbursement_batches. Policies are dropped
-- before RLS is disabled to match dependency order.
--
-- EMERGENCY-ONLY OPERATION. Applying this rollback removes cross-tenant
-- isolation from sensitive financial tables. Without these policies every
-- authenticated database session that can reach fin_expense_policies or
-- fin_reimbursement_batches can read and write rows belonging to any tenant —
-- full cross-tenant data exposure on billing and finance records. Do not apply
-- outside a controlled emergency, and re-apply migration 1116 immediately once
-- the underlying issue is resolved.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON public.fin_expense_policies;
--> statement-breakpoint
ALTER TABLE public.fin_expense_policies DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON public.fin_reimbursement_batches;
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches DISABLE ROW LEVEL SECURITY;
