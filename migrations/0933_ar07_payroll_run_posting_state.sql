SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "posting_state" text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_runs_org_posting_state" ON "payroll_runs" ("org_id", "posting_state");
