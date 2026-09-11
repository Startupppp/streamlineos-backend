-- csat_surveys already mints an unguessable public_token per survey (uniqueIndex
-- idx_csat_surveys_token) but the public submit route looked the row up by its serial id, so
-- migration 0384 deliberately left this table off the public-read arm — a countable id would let
-- anyone read any tenant's survey. The route is now keyed by the token, which makes the same arm
-- 0384 gave agent_tokens and api_keys safe here: a caller sees exactly the one row whose token they
-- hold. The response insert runs in that org's tenant transaction, so WITH CHECK stays strict.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "csat_surveys";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "csat_surveys"
  FOR ALL
  TO PUBLIC
  USING (
    "org_id" = app.current_org_id_or_null()
    OR "public_token" = app.current_public_token_or_null()
  )
  WITH CHECK ("org_id" = app.current_org_id());
