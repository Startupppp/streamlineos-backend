-- Rollback for migration 1117.
--
-- EMERGENCY USE ONLY. Rolling this back removes the tenant_isolation RLS policy
-- and disables RLS on public.subscription_purchases, making every payment record
-- readable and writable across org boundaries until RLS is re-enabled. The
-- SECURITY DEFINER helper app.subscription_purchase_org_for_order is also
-- dropped, breaking billing-webhook.handler.ts:settle() at the org-lookup step.
-- Do not apply on production without an immediate re-migration plan.
--
-- Reverse order: drop the policy first, then disable RLS, then drop the
-- function. The policy and the function are independent, but clearing the
-- policy before disabling RLS keeps the sequence structurally faithful to the
-- forward migration in reverse.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.subscription_purchases;
--> statement-breakpoint
ALTER TABLE public.subscription_purchases DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP FUNCTION IF EXISTS app.subscription_purchase_org_for_order(text);
