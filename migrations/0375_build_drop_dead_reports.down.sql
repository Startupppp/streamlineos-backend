-- Rollback for 0375 — recreate the `reports` table exactly as it was defined in
-- db/schema/build/core.ts before removal (columns, defaults, FKs, index, candidate key).
--
-- Structure is fully restored. Data is not: the table was empty at drop time (0375's
-- guard refuses to drop a non-empty table), so there is nothing to restore.

SET statement_timeout = 0;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reports" (
  "id"              serial PRIMARY KEY NOT NULL,
  "org_id"          text NOT NULL,
  "name"            text NOT NULL,
  "type"            text NOT NULL,
  "config"          jsonb,
  "created_by"      text,
  "is_scheduled"    boolean DEFAULT false NOT NULL,
  "schedule_config" jsonb,
  "created_at"      timestamp DEFAULT now() NOT NULL,
  "updated_at"      timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_org_id_organizations_id_fk') THEN
    ALTER TABLE "reports" ADD CONSTRAINT "reports_org_id_organizations_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_created_by_users_id_fk') THEN
    ALTER TABLE "reports" ADD CONSTRAINT "reports_created_by_users_id_fk"
      FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_reports_org_id') THEN
    ALTER TABLE "reports" ADD CONSTRAINT "uniq_reports_org_id" UNIQUE ("org_id", "id");
  END IF;
END $$;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reports_org_type" ON "reports" ("org_id", "type");
