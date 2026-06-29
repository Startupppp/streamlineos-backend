-- Project Templates: pre-built task structures that can bootstrap new projects
CREATE TABLE IF NOT EXISTS "project_templates" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "description" text,
  "category" text DEFAULT 'GENERAL',
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "project_template_tickets" (
  "id" serial PRIMARY KEY,
  "template_id" integer NOT NULL REFERENCES "project_templates"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "description" text,
  "type" text DEFAULT 'TASK',
  "priority" text DEFAULT 'MEDIUM',
  "estimated_hours" decimal,
  "order" integer NOT NULL DEFAULT 0,
  "phase" text
);

CREATE INDEX IF NOT EXISTS "idx_project_template_tickets_template"
  ON "project_template_tickets"("template_id");
