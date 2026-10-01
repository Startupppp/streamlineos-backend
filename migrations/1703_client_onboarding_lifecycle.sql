SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "client_onboarding_template_items" (
  "id"          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"      TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "template_id" INTEGER NOT NULL,
  "title"       TEXT NOT NULL,
  "description" TEXT,
  "sort_order"  INTEGER NOT NULL DEFAULT 0,
  "created_at"  TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "fk_client_onboarding_template_items_org_template"
    FOREIGN KEY ("org_id", "template_id")
    REFERENCES "client_onboarding_templates"("org_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_client_onboarding_template_items_template"
  ON "client_onboarding_template_items" ("org_id", "template_id", "sort_order");
--> statement-breakpoint

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY org_id ORDER BY updated_at DESC, id DESC) AS position
  FROM client_onboarding_templates
  WHERE is_default = true
)
UPDATE client_onboarding_templates t
SET is_default = false, updated_at = now()
FROM ranked r
WHERE t.id = r.id AND r.position > 1;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_client_onboarding_templates_default"
  ON "client_onboarding_templates" ("org_id") WHERE "is_default" = true;
--> statement-breakpoint

ALTER TABLE "client_onboarding_items" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMP;
ALTER TABLE "client_onboarding_items" ADD COLUMN IF NOT EXISTS "archived_by" TEXT REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "client_onboarding_items" ADD COLUMN IF NOT EXISTS "archived_by_membership_id" INTEGER;
--> statement-breakpoint

ALTER TABLE "client_onboarding_items" DROP CONSTRAINT IF EXISTS "client_onboarding_items_client_id_clients_id_fk";
ALTER TABLE "client_onboarding_items" DROP CONSTRAINT IF EXISTS "fk_client_onboarding_items_client_id_org";
ALTER TABLE "client_onboarding_items" ADD CONSTRAINT "fk_client_onboarding_items_client_id_org"
  FOREIGN KEY ("org_id", "client_id") REFERENCES "client_party_map"("organization_id", "client_id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "client_onboarding_items" VALIDATE CONSTRAINT "fk_client_onboarding_items_client_id_org";
--> statement-breakpoint

ALTER TABLE "client_onboarding_items" ADD CONSTRAINT "fk_client_onboarding_items_org_archiver_membership"
  FOREIGN KEY ("org_id", "archived_by_membership_id") REFERENCES "organization_members"("org_id", "id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "client_onboarding_items" VALIDATE CONSTRAINT "fk_client_onboarding_items_org_archiver_membership";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_client_onboarding_items_active_client"
  ON "client_onboarding_items" ("org_id", "client_id", "sort_order", "id") WHERE "archived_at" IS NULL;
--> statement-breakpoint

ALTER TABLE "client_onboarding_template_items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "client_onboarding_template_items";
CREATE POLICY tenant_isolation ON "client_onboarding_template_items"
  FOR ALL USING ("org_id" = app.current_org_id()) WITH CHECK ("org_id" = app.current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "client_onboarding_template_items" TO streamline_app;
GRANT USAGE, SELECT ON SEQUENCE "client_onboarding_template_items_id_seq" TO streamline_app;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'uniq_client_onboarding_templates_default'
  ), '1703 post-check: default template uniqueness is absent';
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'client_onboarding_items' AND column_name = 'archived_at'
  ), '1703 post-check: onboarding archive lifecycle is absent';
END $$;
--> statement-breakpoint
