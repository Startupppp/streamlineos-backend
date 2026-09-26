SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.projects') IS NULL THEN
    RAISE EXCEPTION '1295 precondition: build.projects is absent — this is not a Build database';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_projects_org_id') THEN
    RAISE EXCEPTION '1295 precondition: uniq_projects_org_id composite unique is absent — tenant-safe FK cannot be declared';
  END IF;
  IF to_regclass('build.project_retention_settings') IS NOT NULL THEN
    RAISE EXCEPTION '1295 precondition: build.project_retention_settings already exists — migration has already run';
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."project_retention_settings" (
  "id"                            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"                        text NOT NULL,
  "project_id"                    integer NOT NULL,
  "inherit_org_policy"            boolean NOT NULL DEFAULT TRUE,
  "closed_ticket_retention_days"  integer,
  "attachment_retention_days"     integer,
  "audit_log_retention_days"      integer,
  "legal_hold"                    boolean NOT NULL DEFAULT FALSE,
  "legal_hold_reason"             text,
  "legal_hold_set_at"             timestamptz,
  "version"                       integer NOT NULL DEFAULT 1,
  "updated_at"                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_project_retention_settings_org_project" UNIQUE ("org_id", "project_id"),
  CONSTRAINT "uniq_project_retention_settings_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_retention_days_valid" CHECK (
    closed_ticket_retention_days IS NULL OR closed_ticket_retention_days IN (30, 60, 90, 180, 365)
  ),
  CONSTRAINT "chk_attachment_days_valid" CHECK (
    attachment_retention_days IS NULL OR attachment_retention_days IN (30, 60, 90, 180, 365)
  ),
  CONSTRAINT "chk_audit_log_days_valid" CHECK (
    audit_log_retention_days IS NULL OR audit_log_retention_days IN (30, 60, 90, 180, 365)
  )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_project_retention_settings_org_project"
  ON "build"."project_retention_settings" ("org_id", "project_id");
--> statement-breakpoint

ALTER TABLE "build"."project_retention_settings"
  ADD CONSTRAINT "fk_project_retention_settings_org"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_retention_settings"
  VALIDATE CONSTRAINT "fk_project_retention_settings_org";
--> statement-breakpoint

ALTER TABLE "build"."project_retention_settings"
  ADD CONSTRAINT "fk_project_retention_settings_org_project"
  FOREIGN KEY ("org_id", "project_id") REFERENCES "build"."projects" ("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_retention_settings"
  VALIDATE CONSTRAINT "fk_project_retention_settings_org_project";
--> statement-breakpoint

ALTER TABLE "build"."project_retention_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "build"."project_retention_settings";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "build"."project_retention_settings"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."project_retention_settings" TO streamline_app;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT to_regclass('build.project_retention_settings') IS NOT NULL,
    '1295 post-check: build.project_retention_settings was not created';
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'project_retention_settings'
      AND indexname = 'idx_project_retention_settings_org_project'
  ), '1295 post-check: idx_project_retention_settings_org_project is missing';
  ASSERT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'build'
      AND tablename = 'project_retention_settings'
      AND policyname = 'tenant_isolation'
  ), '1295 post-check: tenant_isolation RLS policy is missing';
END $$;
