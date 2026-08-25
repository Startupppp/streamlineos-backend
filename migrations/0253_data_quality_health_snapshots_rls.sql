-- Row-level security for `data_quality_health_snapshots`, which shipped without it.
--
-- `0252` created the table with an `organization_id` column and no policy. Every
-- other tenant table added in this programme carries the block below, and both
-- of this one's immediate siblings — `data_quality_findings` and
-- `issue_records` — have it. This one was simply missed.
--
-- Why it matters even though nothing is leaking today: the application currently
-- connects as `neondb_owner`, which has BYPASSRLS, so *every* policy in the
-- database is inert right now. That is exactly why a missing one is easy to
-- ship and impossible to notice — the table behaves identically with and without
-- it until the day the application moves to `streamline_app`, at which point
-- this table would be the one that kept answering for every tenant at once.
--
-- What it would expose is an aggregate rather than a customer record: a per-day
-- composite of one tenant's open data-quality queue. That is still a tenant's
-- operational posture — how much bad data they have and whether it is getting
-- worse — and it is not ours to hand to their competitor.
--
-- The order below is the one the rest of the series uses and is not arbitrary:
-- ENABLE, then DROP IF EXISTS so a re-run is clean, then CREATE, then REVOKE the
-- public grant, then GRANT to the application role. Reversing the last two would
-- briefly leave PUBLIC holding rights on a table whose policy is already live.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "data_quality_health_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "data_quality_health_snapshots";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "data_quality_health_snapshots"
  USING ("organization_id" = app.current_org_id())
  WITH CHECK ("organization_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "data_quality_health_snapshots" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "data_quality_health_snapshots" TO streamline_app;
