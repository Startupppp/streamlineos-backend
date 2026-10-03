-- 1728 — the last five single-column foreign keys between two tenant tables.
--
-- check:tenant-relationships (AR-02) requires every FK whose child and parent both carry org_id
-- to be composite, (org_id, child_id) -> (org_id, id), so a row in one organisation cannot point
-- at a parent in another. With the cold chain now reaching journal head, the gate reads a
-- complete catalog for the first time and names five:
--
--   build.project_webhooks.integrations_endpoint_id -> integration_webhook_endpoint_credentials
--   integration_webhook_deliveries.credential_id    -> integration_webhook_endpoint_credentials
--   invitation_module_access.invitation_id          -> invitations
--   kb_version_restore_audit.page_id                -> kb_pages
--   tax_registrations.party_id                      -> gl_parties
--
-- The first four are replaced in place under the same name, so any handler naming the
-- constraint still matches. Each parent already has a unique (org_id, id). The ON DELETE action
-- is kept; for the two nullable children SET NULL carries a column list, because a bare
-- SET NULL on (org_id, x) would null the NOT NULL org_id and abort the delete.
--
-- tax_registrations already has the composite twins fk_tax_registrations_org_party and
-- fk_tax_registrations_party_id_org (0969); the single-column fk_tax_registrations_party only
-- survived because 0619 recreated it from the production catalog. It is dropped, not replaced.
--
-- NOT VALID, then VALIDATE (BE-62). VALIDATE fails if any existing row points across
-- organisations — that would be a real cross-tenant reference and must be fixed by hand, not
-- by this migration.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."project_webhooks" DROP CONSTRAINT IF EXISTS "fk_project_webhooks_integrations_endpoint";
--> statement-breakpoint
ALTER TABLE "build"."project_webhooks"
  ADD CONSTRAINT "fk_project_webhooks_integrations_endpoint"
  FOREIGN KEY ("org_id", "integrations_endpoint_id")
  REFERENCES "public"."integration_webhook_endpoint_credentials" ("org_id", "id")
  ON DELETE SET NULL ("integrations_endpoint_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_webhooks" VALIDATE CONSTRAINT "fk_project_webhooks_integrations_endpoint";
--> statement-breakpoint

ALTER TABLE "public"."integration_webhook_deliveries" DROP CONSTRAINT IF EXISTS "fk_int_wh_deliveries_credential";
--> statement-breakpoint
ALTER TABLE "public"."integration_webhook_deliveries"
  ADD CONSTRAINT "fk_int_wh_deliveries_credential"
  FOREIGN KEY ("org_id", "credential_id")
  REFERENCES "public"."integration_webhook_endpoint_credentials" ("org_id", "id")
  ON DELETE SET NULL ("credential_id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."integration_webhook_deliveries" VALIDATE CONSTRAINT "fk_int_wh_deliveries_credential";
--> statement-breakpoint

ALTER TABLE "public"."invitation_module_access" DROP CONSTRAINT IF EXISTS "fk_ima_invitation";
--> statement-breakpoint
ALTER TABLE "public"."invitation_module_access"
  ADD CONSTRAINT "fk_ima_invitation"
  FOREIGN KEY ("org_id", "invitation_id")
  REFERENCES "public"."invitations" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."invitation_module_access" VALIDATE CONSTRAINT "fk_ima_invitation";
--> statement-breakpoint

ALTER TABLE "public"."kb_version_restore_audit" DROP CONSTRAINT IF EXISTS "fk_kb_version_restore_audit_page";
--> statement-breakpoint
ALTER TABLE "public"."kb_version_restore_audit"
  ADD CONSTRAINT "fk_kb_version_restore_audit_page"
  FOREIGN KEY ("org_id", "page_id")
  REFERENCES "public"."kb_pages" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_version_restore_audit" VALIDATE CONSTRAINT "fk_kb_version_restore_audit_page";
--> statement-breakpoint

ALTER TABLE "public"."tax_registrations" DROP CONSTRAINT IF EXISTS "fk_tax_registrations_party";
