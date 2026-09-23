SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.project_incidents') IS NULL THEN
    RAISE EXCEPTION '1166 precondition: build.project_incidents is absent — this is not a Build database';
  END IF;
  IF to_regclass('build.project_releases') IS NULL THEN
    RAISE EXCEPTION '1166 precondition: build.project_releases is absent — this is not a Build database';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'build' AND table_name = 'project_incidents'
       AND column_name = 'release_id'
  ) THEN
    RAISE EXCEPTION '1166 precondition: build.project_incidents.release_id already exists — this migration has run';
  END IF;
  IF to_regclass('build.incident_decisions') IS NOT NULL THEN
    RAISE EXCEPTION '1166 precondition: build.incident_decisions already exists — this migration has run';
  END IF;
  IF to_regclass('build.incident_follow_up_actions') IS NOT NULL THEN
    RAISE EXCEPTION '1166 precondition: build.incident_follow_up_actions already exists — this migration has run';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_project_incidents_org_id') THEN
    RAISE EXCEPTION '1166 precondition: uniq_project_incidents_org_id is absent — the tenant-safe composite foreign key cannot be declared';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_project_releases_org_id') THEN
    RAISE EXCEPTION '1166 precondition: uniq_project_releases_org_id is absent — the tenant-safe composite foreign key cannot be declared';
  END IF;
END $$;
--> statement-breakpoint

-- 1. Link an incident to the release it affected (`project_releases` is the
--    codebase's one canonical release entity; there is no separate service
--    catalog to link to — see db/schema/build/incidents.ts).

ALTER TABLE "build"."project_incidents"
  ADD COLUMN IF NOT EXISTS "release_id" integer;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_project_incidents_release"
  ON "build"."project_incidents" ("release_id");
--> statement-breakpoint

ALTER TABLE "build"."project_incidents"
  ADD CONSTRAINT "fk_project_incidents_org_release"
  FOREIGN KEY ("org_id", "release_id") REFERENCES "build"."project_releases" ("org_id", "id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_incidents"
  VALIDATE CONSTRAINT "fk_project_incidents_org_release";
--> statement-breakpoint

-- 2. Decisions: an append-only log, the same shape as the existing
--    incident_updates table (insert + list, no update, no delete).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'incident_follow_up_status') THEN
    CREATE TYPE "public"."incident_follow_up_status" AS ENUM ('open', 'in_progress', 'done', 'cancelled');
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."incident_decisions" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "incident_id" integer NOT NULL,
  "decision" text NOT NULL,
  "rationale" text,
  "decided_by" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_incident_decisions_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_incident_decisions_incident"
  ON "build"."incident_decisions" ("incident_id");
--> statement-breakpoint

ALTER TABLE "build"."incident_decisions"
  ADD CONSTRAINT "incident_decisions_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."incident_decisions"
  VALIDATE CONSTRAINT "incident_decisions_org_id_organizations_id_fk";
--> statement-breakpoint

ALTER TABLE "build"."incident_decisions"
  ADD CONSTRAINT "fk_incident_decisions_org_incident"
  FOREIGN KEY ("org_id", "incident_id") REFERENCES "build"."project_incidents" ("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."incident_decisions"
  VALIDATE CONSTRAINT "fk_incident_decisions_org_incident";
--> statement-breakpoint

ALTER TABLE "build"."incident_decisions"
  ADD CONSTRAINT "incident_decisions_decided_by_users_id_fk"
  FOREIGN KEY ("decided_by") REFERENCES "public"."users" ("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."incident_decisions"
  VALIDATE CONSTRAINT "incident_decisions_decided_by_users_id_fk";
--> statement-breakpoint

ALTER TABLE "build"."incident_decisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "build"."incident_decisions";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "build"."incident_decisions"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."incident_decisions" TO streamline_app;
--> statement-breakpoint

-- 3. Follow-up actions: each has its own lifecycle (status, owner, due date),
--    normalized per BE-42 rather than a JSONB array.

CREATE TABLE IF NOT EXISTS "build"."incident_follow_up_actions" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "incident_id" integer NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "owner_id" text,
  "status" "public"."incident_follow_up_status" NOT NULL DEFAULT 'open',
  "due_at" timestamp,
  "created_by" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "deleted_at" timestamp,
  CONSTRAINT "uniq_incident_follow_up_actions_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_incident_follow_up_actions_org_incident_status"
  ON "build"."incident_follow_up_actions" ("org_id", "incident_id", "status")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

ALTER TABLE "build"."incident_follow_up_actions"
  ADD CONSTRAINT "incident_follow_up_actions_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."incident_follow_up_actions"
  VALIDATE CONSTRAINT "incident_follow_up_actions_org_id_organizations_id_fk";
--> statement-breakpoint

ALTER TABLE "build"."incident_follow_up_actions"
  ADD CONSTRAINT "fk_incident_follow_up_actions_org_incident"
  FOREIGN KEY ("org_id", "incident_id") REFERENCES "build"."project_incidents" ("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."incident_follow_up_actions"
  VALIDATE CONSTRAINT "fk_incident_follow_up_actions_org_incident";
--> statement-breakpoint

ALTER TABLE "build"."incident_follow_up_actions"
  ADD CONSTRAINT "incident_follow_up_actions_owner_id_users_id_fk"
  FOREIGN KEY ("owner_id") REFERENCES "public"."users" ("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."incident_follow_up_actions"
  VALIDATE CONSTRAINT "incident_follow_up_actions_owner_id_users_id_fk";
--> statement-breakpoint

ALTER TABLE "build"."incident_follow_up_actions"
  ADD CONSTRAINT "incident_follow_up_actions_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "public"."users" ("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."incident_follow_up_actions"
  VALIDATE CONSTRAINT "incident_follow_up_actions_created_by_users_id_fk";
--> statement-breakpoint

ALTER TABLE "build"."incident_follow_up_actions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "build"."incident_follow_up_actions";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "build"."incident_follow_up_actions"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."incident_follow_up_actions" TO streamline_app;
