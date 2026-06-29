CREATE TYPE "public"."device_status" AS ENUM('ACTIVE', 'INACTIVE', 'LOST', 'RETURNED');--> statement-breakpoint
CREATE TYPE "public"."wfh_request_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "employee_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"device_type" text NOT NULL,
	"device_name" text NOT NULL,
	"serial_number" text,
	"brand" text,
	"model" text,
	"assigned_date" date,
	"return_date" date,
	"status" "device_status" DEFAULT 'ACTIVE',
	"notes" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"budget_limit" numeric,
	"budget_period" text DEFAULT 'MONTHLY',
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"date" date NOT NULL,
	"message" text,
	"notification_sent" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "wfh_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"date" date NOT NULL,
	"reason" text,
	"status" "wfh_request_status" DEFAULT 'PENDING',
	"approver_id" text,
	"rejection_reason" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."document_type";--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('CONTRACT', 'CERTIFICATE', 'ID_PROOF', 'PAYSLIP', 'POLICY', 'OFFER_LETTER', 'RESUME', 'OTHER');--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "type" SET DATA TYPE "public"."document_type" USING "type"::"public"."document_type";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "department_id" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "is_public" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "expiry_date" date;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "expiry_reminder_sent" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "tags" text[];--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "category_id" integer;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "currency" text DEFAULT 'INR';--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "receipt_file_name" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "merchant" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "payment_method" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "project_id" integer;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "approved_at" timestamp;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "paid_at" timestamp;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "transaction_ref" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "updated_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN "status" text DEFAULT 'PENDING';--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN "approved_at" timestamp;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN "is_billable" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN "updated_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "whatsapp_number" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "whatsapp_same_as_phone" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "monthly_salary" numeric;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "employee_id" text;--> statement-breakpoint
ALTER TABLE "employee_devices" ADD CONSTRAINT "employee_devices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_devices" ADD CONSTRAINT "employee_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfh_requests" ADD CONSTRAINT "wfh_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfh_requests" ADD CONSTRAINT "wfh_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfh_requests" ADD CONSTRAINT "wfh_requests_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;