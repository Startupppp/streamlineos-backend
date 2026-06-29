-- Project milestones
CREATE TABLE IF NOT EXISTS "project_milestones" (
  "id" serial PRIMARY KEY,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "description" text,
  "target_date" date NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_project_milestones_project" ON "project_milestones" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_project_milestones_org" ON "project_milestones" ("org_id");

-- Budget columns
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "budget" numeric;
ALTER TABLE "project_members" ADD COLUMN IF NOT EXISTS "hourly_rate" numeric DEFAULT '0';
