-- Custom SQL migration file, put your code below! --

-- Ticket 06 created party_roles, party_merges and party_duplicate_candidates
-- carrying organization_id but no policy, recorded there as "under the party RLS
-- policies only by convention -- pending the matrix". Ticket 07 is the matrix, so
-- the convention becomes a policy here.
--
-- Until now these three were readable organisation-wide: grants arrive through
-- ALTER DEFAULT PRIVILEGES, so a table with RLS off is not protected by the
-- policies on business_parties beside it, and a missing policy is silent. The
-- rows are a party's roles, its merge history including verbatim pre-merge
-- snapshots of both sides, and its suspected-duplicate queue.
--
-- The precondition holds: only PartyService, PartyRolesService and
-- PartyMergeService read or write them, all on the request path, so every
-- statement already runs inside the request's tenant transaction with the GUC
-- set. There is no background sweep over these tables to strand.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "party_roles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "party_roles";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "party_roles"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "party_roles" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "party_roles" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "party_merges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "party_merges";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "party_merges"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "party_merges" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "party_merges" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "party_duplicate_candidates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "party_duplicate_candidates";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "party_duplicate_candidates"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "party_duplicate_candidates" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "party_duplicate_candidates" TO streamline_app;

--> statement-breakpoint
ANALYZE "party_roles";
--> statement-breakpoint
ANALYZE "party_merges";
--> statement-breakpoint
ANALYZE "party_duplicate_candidates";
