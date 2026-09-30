SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('"build"."projects"') IS NULL THEN
    RAISE EXCEPTION '1701 precondition: build.projects table is absent';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."projects"
  ADD COLUMN IF NOT EXISTS "crm_client_id" INTEGER;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_projects_crm_client"
  ON "build"."projects" ("org_id", "crm_client_id")
  WHERE "crm_client_id" IS NOT NULL;
--> statement-breakpoint

GRANT SELECT, UPDATE ON "build"."projects" TO streamline_app;
--> statement-breakpoint

ALTER TABLE "build"."projects"
  ADD CONSTRAINT "fk_projects_org_crm_client"
  FOREIGN KEY ("org_id", "crm_client_id")
  REFERENCES "client_party_map" ("organization_id", "client_id")
  ON DELETE SET NULL ("crm_client_id")
  NOT VALID;
--> statement-breakpoint

ALTER TABLE "build"."projects" VALIDATE CONSTRAINT "fk_projects_org_crm_client";
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'projects'
      AND column_name = 'crm_client_id'
  ) THEN
    RAISE EXCEPTION '1701: crm_client_id column was not added to build.projects';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_projects_org_crm_client'
      AND conrelid = '"build"."projects"'::regclass
      AND convalidated
  ) THEN
    RAISE EXCEPTION '1701: fk_projects_org_crm_client is absent or not validated, so a project could point at a client in another tenant';
  END IF;
END $$;
