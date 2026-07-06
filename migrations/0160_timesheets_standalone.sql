CREATE TABLE IF NOT EXISTS "timesheet_periods" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"total_hours" numeric(8, 2) DEFAULT '0' NOT NULL,
	"billable_hours" numeric(8, 2) DEFAULT '0' NOT NULL,
	"non_billable_hours" numeric(8, 2) DEFAULT '0' NOT NULL,
	"submitted_at" timestamp,
	"approved_at" timestamp,
	"rejected_at" timestamp,
	"locked_at" timestamp,
	"current_approver_id" text REFERENCES "users"("id") ON DELETE set null,
	"approved_by" text REFERENCES "users"("id") ON DELETE set null,
	"rejection_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "timer_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"project_id" integer REFERENCES "projects"("id") ON DELETE set null,
	"ticket_id" integer REFERENCES "tickets"("id") ON DELETE set null,
	"description" text,
	"billable" boolean DEFAULT false NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"last_resumed_at" timestamp,
	"accumulated_seconds" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"source" text DEFAULT 'WEB' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "timesheet_audit_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"actor_user_id" text REFERENCES "users"("id") ON DELETE set null,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "timesheet_rate_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "timesheet_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"rate_card_id" integer REFERENCES "timesheet_rate_cards"("id") ON DELETE set null,
	"project_id" integer REFERENCES "projects"("id") ON DELETE set null,
	"user_id" text REFERENCES "users"("id") ON DELETE set null,
	"client_id" integer,
	"task_id" integer,
	"billing_type" text DEFAULT 'BILLABLE' NOT NULL,
	"bill_rate" numeric(10, 2) NOT NULL,
	"cost_rate" numeric(10, 2),
	"currency" text DEFAULT 'USD' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "project_id" integer;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "timesheet_period_id" integer;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "timer_session_id" integer;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "billing_type" text DEFAULT 'BILLABLE' NOT NULL;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "bill_rate" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "cost_rate" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "currency" text;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "rate_source" text;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "invoicing_status" text DEFAULT 'UNINVOICED' NOT NULL;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "submitted_at" timestamp;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "locked_at" timestamp;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "locked_by" text;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "voided_at" timestamp;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "void_reason" text;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'MANUAL' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_timesheet_period_id_fk" FOREIGN KEY ("timesheet_period_id") REFERENCES "timesheet_periods"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_timer_session_id_fk" FOREIGN KEY ("timer_session_id") REFERENCES "timer_sessions"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_timesheet_periods_user_range" ON "timesheet_periods" ("org_id","user_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timesheet_periods_user_start" ON "timesheet_periods" ("org_id","user_id","period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timesheet_periods_org_status" ON "timesheet_periods" ("org_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timer_sessions_user_status" ON "timer_sessions" ("org_id","user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timesheet_audit_entity" ON "timesheet_audit_events" ("org_id","entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timesheet_rate_cards_org" ON "timesheet_rate_cards" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timesheet_rates_org_priority" ON "timesheet_rates" ("org_id","priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timesheet_rates_org_project" ON "timesheet_rates" ("org_id","project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timesheets_org_project_date" ON "timesheets" ("org_id","project_id","date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timesheets_org_invoicing" ON "timesheets" ("org_id","invoicing_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timesheets_period" ON "timesheets" ("timesheet_period_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "timesheet_budgets" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"project_id" integer REFERENCES "projects"("id") ON DELETE cascade,
	"client_id" integer,
	"budget_type" text DEFAULT 'HOURS' NOT NULL,
	"budget_hours" numeric(10, 2),
	"budget_amount" numeric(12, 2),
	"currency" text DEFAULT 'USD' NOT NULL,
	"alert_thresholds" jsonb DEFAULT '[50,80,100]'::jsonb NOT NULL,
	"starts_at" date,
	"ends_at" date,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timesheet_budgets_org_status" ON "timesheet_budgets" ("org_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timesheet_budgets_org_project" ON "timesheet_budgets" ("org_id","project_id");
