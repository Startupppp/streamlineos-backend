-- ai_action_proposals is a tenant table with a NOT NULL org_id that stores the
-- full payload of every AI-proposed action: leave reasons, candidate emails,
-- bonus amounts, outbound mail bodies and lead PII. It had row-level security
-- switched off. Grants arrive through ALTER DEFAULT PRIVILEGES, so the gap is
-- silent, and tenant isolation rested entirely on application predicates -- and
-- three of those statements carried no org_id at all. The execution-bookkeeping
-- and cancellation UPDATEs identified the row by its bare serial id, and the
-- expiry sweep ran across every tenant at once with no org_id predicate and no
-- tenant GUC, so RLS would have answered it 42501. TODO-5.1/5.2 gave the
-- execution UPDATE an org_id predicate, a restated status and an affected-row
-- check, and deleted the sweep and the unreachable cancellation path. Every
-- statement this table now sees is tenant-scoped; the redemption UPDATE in
-- `confirm` always was.
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "ai_action_proposals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "ai_action_proposals";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_action_proposals"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "ai_action_proposals" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "ai_action_proposals" TO streamline_app;
--> statement-breakpoint

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO missing
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('ai_action_proposals')
    AND (NOT c.relrowsecurity
         OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid));
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '1123: % still lacks RLS or a policy', missing;
  END IF;
END $$;
