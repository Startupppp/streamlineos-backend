-- Add recurrence support to tasks
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "recurrence" jsonb;
-- recurrence: { frequency: "DAILY"|"WEEKLY"|"MONTHLY", interval: number, endDate?: string }

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "parent_task_id" integer REFERENCES "tasks"("id");
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "is_template" boolean NOT NULL DEFAULT false;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "template_name" text;

CREATE INDEX IF NOT EXISTS "idx_tasks_parent" ON "tasks"("parent_task_id");
CREATE INDEX IF NOT EXISTS "idx_tasks_template" ON "tasks"("org_id") WHERE "is_template" = true;

-- Task templates table (pre-built sequences)
CREATE TABLE IF NOT EXISTS "task_sequences" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "description" text,
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "task_sequence_steps" (
  "id" serial PRIMARY KEY,
  "sequence_id" integer NOT NULL REFERENCES "task_sequences"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "type" text NOT NULL DEFAULT 'CUSTOM',
  "notes" text,
  "offset_days" integer NOT NULL DEFAULT 0,
  "order" integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS "idx_task_sequence_steps_seq" ON "task_sequence_steps"("sequence_id");
