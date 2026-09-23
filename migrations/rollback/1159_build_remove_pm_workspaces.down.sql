SET lock_timeout = '5s';
--> statement-breakpoint

SET statement_timeout = 0;
--> statement-breakpoint

DO $$
BEGIN
  RAISE NOTICE '1159 rollback restores schema shape only. PM Workspace rows, and every pm_workspace_id value, were deleted by 1159 and are not recoverable here. Restored pm_workspace_id columns are NULLABLE with no foreign key because they are entirely NULL. To recover data, restore the RDS snapshot taken before 1159.';
END
$$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."pm_workspaces" (
  "pm_workspace_id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "deleted_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_pm_workspaces_org_workspace" UNIQUE ("org_id", "pm_workspace_id"),
  CONSTRAINT "chk_pm_workspaces_status" CHECK ("status" IN ('active','archived'))
);
--> statement-breakpoint

ALTER TABLE "build"."pm_workspaces"
  ADD CONSTRAINT "pm_workspaces_org_id_fkey" FOREIGN KEY ("org_id")
  REFERENCES "public"."organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE "build"."pm_workspaces" VALIDATE CONSTRAINT "pm_workspaces_org_id_fkey";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_pm_workspaces_org_default" ON "build"."pm_workspaces" ("org_id") WHERE "is_default" = true;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_pm_workspaces_org_slug" ON "build"."pm_workspaces" ("org_id", "slug");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_pm_workspaces_org" ON "build"."pm_workspaces" ("org_id") WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_pm_workspaces_org_created_slug" ON "build"."pm_workspaces" ("org_id", "created_at", "slug");
--> statement-breakpoint

ALTER TABLE "build"."pm_workspaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "build"."pm_workspaces"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."pm_workspaces" TO "streamline_app";
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."pm_workspace_memberships" (
  "pm_workspace_membership_id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "pm_workspace_id" text NOT NULL,
  "organization_membership_id" integer NOT NULL,
  "role" text DEFAULT 'member' NOT NULL,
  "added_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_pm_workspace_memberships_org_id" UNIQUE ("org_id", "pm_workspace_membership_id"),
  CONSTRAINT "uniq_pm_ws_members_org_ws_member" UNIQUE ("org_id", "pm_workspace_id", "organization_membership_id")
);
--> statement-breakpoint

ALTER TABLE "build"."pm_workspace_memberships"
  ADD CONSTRAINT "pm_workspace_memberships_org_id_fkey" FOREIGN KEY ("org_id")
  REFERENCES "public"."organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE "build"."pm_workspace_memberships" VALIDATE CONSTRAINT "pm_workspace_memberships_org_id_fkey";
--> statement-breakpoint

ALTER TABLE "build"."pm_workspace_memberships"
  ADD CONSTRAINT "fk_pm_ws_members_org_workspace" FOREIGN KEY ("org_id", "pm_workspace_id")
  REFERENCES "build"."pm_workspaces"("org_id", "pm_workspace_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE "build"."pm_workspace_memberships" VALIDATE CONSTRAINT "fk_pm_ws_members_org_workspace";
--> statement-breakpoint

ALTER TABLE "build"."pm_workspace_memberships"
  ADD CONSTRAINT "fk_pm_ws_members_org_membership" FOREIGN KEY ("org_id", "organization_membership_id")
  REFERENCES "public"."organization_members"("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE "build"."pm_workspace_memberships" VALIDATE CONSTRAINT "fk_pm_ws_members_org_membership";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_pm_ws_members_membership" ON "build"."pm_workspace_memberships" ("organization_membership_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_pm_workspace_memberships_org_ws_added" ON "build"."pm_workspace_memberships" ("org_id", "pm_workspace_id", "added_at", "organization_membership_id");
--> statement-breakpoint

ALTER TABLE "build"."pm_workspace_memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "build"."pm_workspace_memberships"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."pm_workspace_memberships" TO "streamline_app";
--> statement-breakpoint

DO $$
DECLARE
  con record;
BEGIN
  IF to_regclass('build.build_members') IS NULL THEN
    RAISE EXCEPTION '1159 rollback: build.build_members is absent — nothing to rename back';
  END IF;

  EXECUTE 'ALTER TABLE "build"."build_members" RENAME TO "project_workspace_members"';
  EXECUTE 'ALTER SEQUENCE "build"."build_members_id_seq" RENAME TO "project_workspace_members_id_seq"';
  EXECUTE 'ALTER TABLE "build"."project_workspace_members" RENAME CONSTRAINT "build_members_pkey" TO "project_workspace_members_pkey"';
  EXECUTE 'ALTER TABLE "build"."project_workspace_members" RENAME CONSTRAINT "uniq_build_members_org_id" TO "uniq_project_workspace_members_org_id"';
  EXECUTE 'ALTER TABLE "build"."project_workspace_members" RENAME CONSTRAINT "fk_build_members_actor" TO "fk_project_workspace_members_actor"';
  EXECUTE 'ALTER TABLE "build"."project_workspace_members" RENAME CONSTRAINT "fk_build_members_org" TO "project_workspace_members_org_id_fkey"';
  EXECUTE 'ALTER INDEX "build"."uniq_build_members_org_membership" RENAME TO "uniq_project_workspace_members_org_user"';

  FOR con IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = to_regclass('build.project_workspace_members')
       AND conname LIKE 'build_members_%'
  LOOP
    EXECUTE format(
      'ALTER TABLE "build"."project_workspace_members" RENAME CONSTRAINT %I TO %I',
      con.conname,
      'project_workspace_members_' || substring(con.conname from length('build_members_') + 1)
    );
  END LOOP;
END
$$;
--> statement-breakpoint

ALTER TABLE "build"."projects" ADD COLUMN IF NOT EXISTS "pm_workspace_id" text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_projects_org_pm_workspace" ON "build"."projects" ("org_id", "pm_workspace_id");
--> statement-breakpoint

ALTER TABLE "build"."managed_products" ADD COLUMN IF NOT EXISTS "pm_workspace_id" text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_managed_products_org_pm_workspace" ON "build"."managed_products" ("org_id", "pm_workspace_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_managed_products_org_workspace" ON "build"."managed_products" ("org_id", "pm_workspace_id") WHERE "deleted_at" IS NULL;
--> statement-breakpoint

ALTER TABLE "build"."project_teams" ADD COLUMN IF NOT EXISTS "pm_workspace_id" text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_project_teams_org_pm_workspace" ON "build"."project_teams" ("org_id", "pm_workspace_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_project_teams_org_workspace" ON "build"."project_teams" ("org_id", "pm_workspace_id") WHERE "deleted_at" IS NULL;
--> statement-breakpoint

ALTER TABLE "build"."project_workspace_members" ADD COLUMN IF NOT EXISTS "pm_workspace_id" text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_project_workspace_members_org_pm_workspace" ON "build"."project_workspace_members" ("org_id", "pm_workspace_id");
--> statement-breakpoint

ALTER TABLE "public"."project_client_grants" ADD COLUMN IF NOT EXISTS "pm_workspace_id" text;
