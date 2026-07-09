ALTER TABLE "git_connections" ADD COLUMN IF NOT EXISTS "project_id" integer;

ALTER TABLE "git_connections"
  ADD CONSTRAINT "git_connections_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "idx_git_connections_project" ON "git_connections" ("project_id");
