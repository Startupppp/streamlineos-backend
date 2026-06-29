ALTER TABLE "performance_improvement_plans" ADD COLUMN IF NOT EXISTS "hr_rep_id" text REFERENCES "users"("id");
