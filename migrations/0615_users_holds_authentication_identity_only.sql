SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_users_reporting_to";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_users_org_department";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_reporting_to_users_id_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "fk_users_branch_id";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "joining_date";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "tax_id";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "bank_details";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "org_department_id";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "designation";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "monthly_salary";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "employee_id";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "reporting_to";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "branch_id";
