-- Rollback for 1728_tenant_composite_fks: restore the single-column forms it replaced.
-- This reopens the cross-tenant references check:tenant-relationships exists to forbid; use it
-- only to back the migration out, not as a resting state.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "build"."project_webhooks" DROP CONSTRAINT IF EXISTS "fk_project_webhooks_integrations_endpoint";
--> statement-breakpoint
ALTER TABLE "build"."project_webhooks" ADD CONSTRAINT "fk_project_webhooks_integrations_endpoint"
  FOREIGN KEY ("integrations_endpoint_id") REFERENCES "public"."integration_webhook_endpoint_credentials" ("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "public"."integration_webhook_deliveries" DROP CONSTRAINT IF EXISTS "fk_int_wh_deliveries_credential";
--> statement-breakpoint
ALTER TABLE "public"."integration_webhook_deliveries" ADD CONSTRAINT "fk_int_wh_deliveries_credential"
  FOREIGN KEY ("credential_id") REFERENCES "public"."integration_webhook_endpoint_credentials" ("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "public"."invitation_module_access" DROP CONSTRAINT IF EXISTS "fk_ima_invitation";
--> statement-breakpoint
ALTER TABLE "public"."invitation_module_access" ADD CONSTRAINT "fk_ima_invitation"
  FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations" ("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."kb_version_restore_audit" DROP CONSTRAINT IF EXISTS "fk_kb_version_restore_audit_page";
--> statement-breakpoint
ALTER TABLE "public"."kb_version_restore_audit" ADD CONSTRAINT "fk_kb_version_restore_audit_page"
  FOREIGN KEY ("page_id") REFERENCES "public"."kb_pages" ("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."tax_registrations" ADD CONSTRAINT "fk_tax_registrations_party"
  FOREIGN KEY ("party_id") REFERENCES "public"."gl_parties" ("id") ON DELETE CASCADE;
