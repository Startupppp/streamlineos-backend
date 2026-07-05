-- 0155_payroll_gapclosure
-- Additive payroll gap-closure DDL (bonus/fnf enum values, bonus.taxable, reimbursement.payroll_month,
-- tax declaration previous-employment fields, accounting-mapping uniqueness).
-- Apply manually; unjournaled. Renumber if it collides with a sibling migration before db:migrate.
-- ALTER TYPE ... ADD VALUE is safe: the new values are added here but never referenced in this migration.
ALTER TYPE "bonus_type" ADD VALUE IF NOT EXISTS 'JOINING';--> statement-breakpoint
ALTER TYPE "bonus_type" ADD VALUE IF NOT EXISTS 'RETENTION';--> statement-breakpoint
ALTER TYPE "bonus_type" ADD VALUE IF NOT EXISTS 'COMMISSION';--> statement-breakpoint
ALTER TYPE "bonus_type" ADD VALUE IF NOT EXISTS 'ADJUSTMENT';--> statement-breakpoint
ALTER TYPE "fnf_status" ADD VALUE IF NOT EXISTS 'HR_REVIEW';--> statement-breakpoint
ALTER TYPE "fnf_status" ADD VALUE IF NOT EXISTS 'FINANCE_REVIEW';--> statement-breakpoint
ALTER TABLE "bonuses" ADD COLUMN IF NOT EXISTS "taxable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "reimbursements" ADD COLUMN IF NOT EXISTS "payroll_month" text;--> statement-breakpoint
ALTER TABLE "tax_declarations" ADD COLUMN IF NOT EXISTS "previous_employment_income" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_declarations" ADD COLUMN IF NOT EXISTS "previous_employer_tds" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_payroll_accounting_mappings_org_component" ON "payroll_accounting_mappings" ("org_id","component_id") WHERE "component_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_payroll_accounting_mappings_org_category" ON "payroll_accounting_mappings" ("org_id","category") WHERE "component_id" IS NULL;
