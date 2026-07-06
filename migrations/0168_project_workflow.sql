ALTER TABLE "project_statuses" ADD COLUMN IF NOT EXISTS "wip_limit" integer;

CREATE TABLE IF NOT EXISTS "workflow_transitions" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "project_id" integer NOT NULL,
  "from_status_id" integer,
  "to_status_id" integer NOT NULL,
  "name" text,
  "requires_approval" boolean NOT NULL DEFAULT false,
  "required_fields" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "allowed_roles" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);

ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;

ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_from_status_id_project_statuses_id_fk"
  FOREIGN KEY ("from_status_id") REFERENCES "project_statuses"("id") ON DELETE CASCADE;

ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_to_status_id_project_statuses_id_fk"
  FOREIGN KEY ("to_status_id") REFERENCES "project_statuses"("id") ON DELETE CASCADE;

ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "idx_workflow_transitions_org_project" ON "workflow_transitions" ("org_id", "project_id");
CREATE INDEX IF NOT EXISTS "idx_workflow_transitions_from" ON "workflow_transitions" ("from_status_id");
CREATE INDEX IF NOT EXISTS "idx_workflow_transitions_to" ON "workflow_transitions" ("to_status_id");
