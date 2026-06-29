CREATE TABLE IF NOT EXISTS "onboarding_templates" (
  "id" SERIAL PRIMARY KEY,
  "org_id" TEXT NOT NULL REFERENCES "organizations"("id"),
  "name" TEXT NOT NULL,
  "department_id" INTEGER,
  "description" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_by" TEXT NOT NULL REFERENCES "users"("id"),
  "created_at" TIMESTAMP DEFAULT NOW(),
  "updated_at" TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_onboarding_templates_org" ON "onboarding_templates"("org_id");

CREATE TABLE IF NOT EXISTS "onboarding_template_steps" (
  "id" SERIAL PRIMARY KEY,
  "template_id" INTEGER NOT NULL REFERENCES "onboarding_templates"("id") ON DELETE CASCADE,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "owner_role" TEXT NOT NULL DEFAULT 'NEW_HIRE',
  "due_offset_days" INTEGER NOT NULL DEFAULT 0,
  "is_required" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "onboarding_tasks" (
  "id" SERIAL PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id"),
  "org_id" TEXT NOT NULL REFERENCES "organizations"("id"),
  "template_step_id" INTEGER REFERENCES "onboarding_template_steps"("id"),
  "title" TEXT NOT NULL,
  "description" TEXT,
  "owner_role" TEXT NOT NULL DEFAULT 'NEW_HIRE',
  "due_date" TIMESTAMP,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "completed_at" TIMESTAMP,
  "completed_by" TEXT REFERENCES "users"("id"),
  "created_at" TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_onboarding_tasks_user" ON "onboarding_tasks"("user_id", "org_id");
CREATE INDEX IF NOT EXISTS "idx_onboarding_tasks_status" ON "onboarding_tasks"("org_id", "status");
