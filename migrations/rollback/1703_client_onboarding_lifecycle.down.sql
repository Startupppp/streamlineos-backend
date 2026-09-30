SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_client_onboarding_items_active_client";
DROP INDEX IF EXISTS "uniq_client_onboarding_templates_default";
ALTER TABLE "client_onboarding_items" DROP CONSTRAINT IF EXISTS "fk_client_onboarding_items_org_archiver_membership";
ALTER TABLE "client_onboarding_items" DROP CONSTRAINT IF EXISTS "fk_client_onboarding_items_client_id_org";
ALTER TABLE "client_onboarding_items" ADD CONSTRAINT "fk_client_onboarding_items_client_id_org"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "clients"("org_id", "id") NOT VALID;
ALTER TABLE "client_onboarding_items" VALIDATE CONSTRAINT "fk_client_onboarding_items_client_id_org";
ALTER TABLE "client_onboarding_items" DROP COLUMN IF EXISTS "archived_by_membership_id";
ALTER TABLE "client_onboarding_items" DROP COLUMN IF EXISTS "archived_by";
ALTER TABLE "client_onboarding_items" DROP COLUMN IF EXISTS "archived_at";
DROP TABLE IF EXISTS "client_onboarding_template_items";
--> statement-breakpoint
