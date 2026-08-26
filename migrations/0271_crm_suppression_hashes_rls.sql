-- Row-level security for `crm_suppression_hashes`, the one CRM table that has none.
--
-- Seventy-one CRM tables carry `org_id` and have a policy. This one carries
-- `org_id NOT NULL`, is granted SELECT/INSERT/UPDATE/DELETE to `streamline_app`,
-- and has `relrowsecurity = false`. It was found by asking the database which
-- CRM tables have RLS rather than by reading migrations, which is the only way
-- a missing policy is ever found -- there is nothing to read.
--
-- What it holds is a consent record: a per-channel hash of every address that
-- asked this tenant to stop contacting them, and why. Two things follow. The
-- first is ordinary tenant isolation -- a suppression list names who a
-- competitor has been emailing and who told them to stop, which is commercially
-- sensitive on its own. The second is worse: this table is what a send checks
-- before it sends. A tenant that can read another tenant's rows can also write
-- them, and a suppression list is a table where a *false* row is the damage --
-- inserting one silently stops a legitimate send to somebody who never opted
-- out, and nothing surfaces it, because a suppressed send looks exactly like a
-- send that was never attempted.
--
-- It is inert today for the same reason 0253's was: the application connects as
-- `neondb_owner`, which has BYPASSRLS, so every policy in this database is
-- currently decoration. That is precisely why a missing one survives -- the
-- table behaves identically with and without it right up until the move to
-- `streamline_app`, at which point this is the table that keeps answering for
-- every tenant at once.
--
-- The order below is the series' order and is not arbitrary: ENABLE, then DROP
-- IF EXISTS so a re-run is clean, then CREATE, then REVOKE the PUBLIC grant,
-- then GRANT to the application role. Reversing the last two leaves PUBLIC
-- holding rights on a table whose policy is already live.
--
-- `org_id`, not `organization_id`: this table predates the newer naming and the
-- column is what it is. A policy written against a column that does not exist
-- fails loudly, which is the one comfort here.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "crm_suppression_hashes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_suppression_hashes";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_suppression_hashes"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_suppression_hashes" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_suppression_hashes" TO streamline_app;
