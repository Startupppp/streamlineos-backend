-- ============================================================================
-- Migration 0015: Fix schema drift
--
-- Adds columns that exist in the Drizzle schema but were never captured in a
-- migration file (applied only via db:push on the original database), PLUS
-- re-applies all ALTER TABLE ADD COLUMN statements from migrations 0001-0013
-- using IF NOT EXISTS so the migration is fully idempotent regardless of the
-- DB's current state.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- organizations — columns added via db:push only (not in any migration file)
-- ---------------------------------------------------------------------------
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "logo" text;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "website" text;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "industry" text;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "timezone" text DEFAULT 'Asia/Kolkata';
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "currency" text DEFAULT 'INR';
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "fiscal_year_start" integer DEFAULT 4;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "settings" jsonb;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "billing_email" text;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "address" jsonb;

-- ---------------------------------------------------------------------------
-- users — columns added via db:push only (not in any migration file)
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "login_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locked_until" timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "has_dashboard_access" boolean DEFAULT false NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "reporting_to" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "team" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "branch_id" integer;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emergency_contact" jsonb;

-- ---------------------------------------------------------------------------
-- users — columns from migration 0001 (idempotent re-apply)
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "whatsapp_number" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "whatsapp_same_as_phone" boolean DEFAULT true;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "monthly_salary" numeric;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "employee_id" text;

-- ---------------------------------------------------------------------------
-- documents — columns from migration 0001
-- ---------------------------------------------------------------------------
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "department_id" integer;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "category" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "file_name" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "is_public" boolean DEFAULT false;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "expiry_date" date;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "expiry_reminder_sent" boolean DEFAULT false;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "tags" text[];

-- ---------------------------------------------------------------------------
-- expenses — columns from migration 0001
-- ---------------------------------------------------------------------------
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "category_id" integer;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "currency" text DEFAULT 'INR';
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "receipt_file_name" text;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "merchant" text;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "payment_method" text;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "project_id" integer;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "approved_at" timestamp;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "paid_at" timestamp;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "transaction_ref" text;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now();

-- ---------------------------------------------------------------------------
-- timesheets — columns from migration 0001
-- ---------------------------------------------------------------------------
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'PENDING';
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "approved_by" text;
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "approved_at" timestamp;
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "rejection_reason" text;
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "is_billable" boolean DEFAULT false;
ALTER TABLE "timesheets" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now();

-- ---------------------------------------------------------------------------
-- attendance — columns from migration 0003
-- ---------------------------------------------------------------------------
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "auto_checked_out" boolean DEFAULT false;

-- ---------------------------------------------------------------------------
-- payrolls — columns from migration 0003
-- ---------------------------------------------------------------------------
ALTER TABLE "payrolls" ADD COLUMN IF NOT EXISTS "overtime_type" text;
ALTER TABLE "payrolls" ADD COLUMN IF NOT EXISTS "overtime_days" numeric DEFAULT '0';
ALTER TABLE "payrolls" ADD COLUMN IF NOT EXISTS "overtime_hours" numeric DEFAULT '0';
ALTER TABLE "payrolls" ADD COLUMN IF NOT EXISTS "overtime_amount" numeric DEFAULT '0';

-- ---------------------------------------------------------------------------
-- tickets — columns from migration 0004
-- ---------------------------------------------------------------------------
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "ticket_number" integer;

-- ---------------------------------------------------------------------------
-- leads — columns from migration 0005 (requires lead_priority enum)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "public"."lead_priority" AS ENUM('HOT', 'WARM', 'COLD');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "priority" "lead_priority" DEFAULT 'WARM';

-- ---------------------------------------------------------------------------
-- tickets — columns from migration 0007
-- ---------------------------------------------------------------------------
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "start_date" date;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "due_date" date;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "state_id" integer;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "module_id" integer;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "cycle_id" integer;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "sequence_id" text;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "estimate" integer;

-- ---------------------------------------------------------------------------
-- leads — columns from migration 0007
-- ---------------------------------------------------------------------------
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "score" integer DEFAULT 0;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "sla_deadline" timestamp;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "website" text;

-- ---------------------------------------------------------------------------
-- deals — columns from migration 0007
-- ---------------------------------------------------------------------------
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "linked_lead_id" integer;
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "linked_client_id" integer;
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "sla_deadline" timestamp;

-- ---------------------------------------------------------------------------
-- leave_requests — columns from migration 0010
-- ---------------------------------------------------------------------------
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "priority" text DEFAULT 'MEDIUM';

-- ---------------------------------------------------------------------------
-- soft deletes — from migration 0012
-- ---------------------------------------------------------------------------
ALTER TABLE "leads"    ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;
ALTER TABLE "deals"    ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;
ALTER TABLE "payrolls" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;
ALTER TABLE "clients"  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;
ALTER TABLE "tickets"  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;

-- ---------------------------------------------------------------------------
-- audit columns — from migration 0013
-- ---------------------------------------------------------------------------
ALTER TABLE "leads"    ADD COLUMN IF NOT EXISTS "created_by" text REFERENCES "users"("id");
ALTER TABLE "leads"    ADD COLUMN IF NOT EXISTS "updated_by" text REFERENCES "users"("id");
ALTER TABLE "deals"    ADD COLUMN IF NOT EXISTS "created_by" text REFERENCES "users"("id");
ALTER TABLE "deals"    ADD COLUMN IF NOT EXISTS "updated_by" text REFERENCES "users"("id");
ALTER TABLE "tickets"  ADD COLUMN IF NOT EXISTS "created_by" text REFERENCES "users"("id");
ALTER TABLE "tickets"  ADD COLUMN IF NOT EXISTS "updated_by" text REFERENCES "users"("id");
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "created_by" text REFERENCES "users"("id");
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "updated_by" text REFERENCES "users"("id");
ALTER TABLE "payrolls" ADD COLUMN IF NOT EXISTS "created_by" text REFERENCES "users"("id");
ALTER TABLE "payrolls" ADD COLUMN IF NOT EXISTS "updated_by" text REFERENCES "users"("id");
