-- Custom SQL migration file, put your code below! --

-- 0658 — make a context-less read of crm_whatsapp_channels raise, not return
-- nothing.
--
-- 0657 wrote the read side of the policy with `app.current_org_id_or_null()`.
-- That accessor exists for a specific case 0381 describes: a table whose tenant
-- column is NULLABLE, where a scan crossing a tenant-owned row would otherwise
-- abort a query that only asked for the platform-global ones. This table's
-- `organization_id` is NOT NULL, so it has no such rows and nothing to protect
-- — and the non-raising accessor buys nothing while costing the loud failure.
--
-- The cost is not theoretical. A context-less read under the application role
-- returns zero rows and no error, which is indistinguishable from "this
-- organisation has no channels". That is the exact shape of the bug this
-- module already hit once: the seam verified every delivery, offered every
-- message, and filed nothing, because the writes ran with no tenant context.
-- It read as a provider that had gone quiet. `crm-tenant-isolation` asserts
-- 42501 for every CRM table for that reason, and this table was the first to
-- be added that did not raise.
--
-- The tenant resolution an inbound delivery depends on is unaffected: it goes
-- through the SECURITY DEFINER functions in 0657, which do not consult the
-- policy at all. The row itself is then read inside a real tenant transaction.
-- So this is a strict tightening with no path that loses access.

SET lock_timeout = '5s';

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_whatsapp_channels";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_whatsapp_channels"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
