-- Migration 0216: HR Workforce Planning tables
-- DO NOT RUN -- applied manually after sibling sessions complete

DO $$
BEGIN

CREATE TABLE IF NOT EXISTS "hr_headcount_plans" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "fiscal_year" integer NOT NULL,
  "department_id" integer REFERENCES "departments"("id") ON DELETE SET NULL,
  "budgeted_headcount" integer NOT NULL,
  "budgeted_cost_cents" integer,
  "note" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "hr_hiring_plan_items" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "plan_id" integer NOT NULL REFERENCES "hr_headcount_plans"("id") ON DELETE CASCADE,
  "role_title" text NOT NULL,
  "count" integer NOT NULL DEFAULT 1,
  "target_quarter" integer,
  "status" text NOT NULL DEFAULT 'planned',
  "linked_requisition_id" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Indexes
IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_hr_headcount_plans_org_year_dept') THEN
  CREATE UNIQUE INDEX "uniq_hr_headcount_plans_org_year_dept" ON "hr_headcount_plans"("org_id", "fiscal_year", "department_id");
END IF;

IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_hr_headcount_plans_org') THEN
  CREATE INDEX "idx_hr_headcount_plans_org" ON "hr_headcount_plans"("org_id");
END IF;

IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_hr_hiring_plan_items_plan') THEN
  CREATE INDEX "idx_hr_hiring_plan_items_plan" ON "hr_hiring_plan_items"("plan_id");
END IF;

IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_hr_hiring_plan_items_org') THEN
  CREATE INDEX "idx_hr_hiring_plan_items_org" ON "hr_hiring_plan_items"("org_id");
END IF;

END $$;
