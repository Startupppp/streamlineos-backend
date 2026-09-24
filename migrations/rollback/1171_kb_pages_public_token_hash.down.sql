SET lock_timeout = '5s';
--> statement-breakpoint

DROP POLICY IF EXISTS "tenant_isolation" ON "public"."kb_pages";
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "public"."kb_pages" FOR ALL
  USING (
    "org_id" = app.current_org_id_or_null()
    OR "public_token"::text = app.current_public_token_or_null()
  )
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

DROP INDEX IF EXISTS "public"."uniq_kb_pages_public_token_hash";
--> statement-breakpoint

ALTER TABLE "public"."kb_pages" DROP COLUMN IF EXISTS "public_token_hash";
