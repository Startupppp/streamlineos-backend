CREATE TABLE "project_webhooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"url" text NOT NULL,
	"events" text[] DEFAULT '{}' NOT NULL,
	"secret" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"webhook_id" integer NOT NULL,
	"event" varchar(100) NOT NULL,
	"payload" jsonb,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"response_code" integer,
	"response_body" text,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_shift_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"shift_id" integer NOT NULL,
	"effective_from" text NOT NULL,
	"effective_to" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_swap_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"requester_id" text NOT NULL,
	"target_user_id" text NOT NULL,
	"request_date" text NOT NULL,
	"target_date" text NOT NULL,
	"reason" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"approver_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'FIXED' NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"break_minutes" integer DEFAULT 60 NOT NULL,
	"is_night_shift" boolean DEFAULT false NOT NULL,
	"grace_period_minutes" integer DEFAULT 15 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roster_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"roster_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"shift_id" integer,
	"date" date NOT NULL,
	"is_day_off" jsonb DEFAULT 'false'::jsonb,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rosters" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"week_start" date NOT NULL,
	"week_end" date NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comp_off_balances" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"earned_days" numeric(6, 2) DEFAULT '0' NOT NULL,
	"used_days" numeric(6, 2) DEFAULT '0' NOT NULL,
	"expiry_date" date,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "overtime_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"date" date NOT NULL,
	"hours" numeric(5, 2) NOT NULL,
	"reason" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"approver_id" text,
	"convert_to_comp_off" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geofences" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"lat" numeric(10, 7) NOT NULL,
	"lng" numeric(10, 7) NOT NULL,
	"radius_meters" integer DEFAULT 200 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "biometric_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"ip_address" text NOT NULL,
	"port" integer DEFAULT 4370 NOT NULL,
	"vendor" text DEFAULT 'ZKTeco' NOT NULL,
	"location" text,
	"is_online" boolean DEFAULT false NOT NULL,
	"last_sync_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "biometric_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"device_id" integer NOT NULL,
	"user_id" text,
	"biometric_user_id" text,
	"punch_time" timestamp NOT NULL,
	"punch_type" text DEFAULT 'IN' NOT NULL,
	"raw_data" jsonb,
	"processed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_enrollments" (
	"id" serial PRIMARY KEY NOT NULL,
	"course_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'ENROLLED' NOT NULL,
	"progress_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"completed_at" timestamp,
	"score" numeric(5, 2),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courses" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"category_id" integer,
	"title" text NOT NULL,
	"description" text,
	"instructor_id" text,
	"external_instructor" text,
	"type" text DEFAULT 'INTERNAL' NOT NULL,
	"format" text DEFAULT 'SELF_PACED' NOT NULL,
	"duration_hours" numeric(6, 2),
	"prerequisites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"thumbnail_url" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"is_mandatory" boolean DEFAULT false NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_attendance" (
	"id" serial PRIMARY KEY NOT NULL,
	"program_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'ENROLLED' NOT NULL,
	"feedback_rating" integer,
	"feedback_text" text,
	"certificate_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_programs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text DEFAULT 'MANDATORY' NOT NULL,
	"format" text DEFAULT 'CLASSROOM' NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text,
	"venue" text,
	"virtual_link" text,
	"max_capacity" integer,
	"instructor_id" text,
	"external_instructor" text,
	"is_mandatory" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'SCHEDULED' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_requisitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"department" text,
	"location" text,
	"headcount" integer DEFAULT 1 NOT NULL,
	"budget_min" numeric(15, 2),
	"budget_max" numeric(15, 2),
	"hiring_manager_id" text,
	"priority" text DEFAULT 'MEDIUM' NOT NULL,
	"type" text DEFAULT 'FULL_TIME' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"requested_by" text NOT NULL,
	"approver_id" text,
	"approved_at" timestamp,
	"rejection_reason" text,
	"justification" text,
	"target_date" text,
	"linked_job_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competencies" (
	"id" serial PRIMARY KEY NOT NULL,
	"framework_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"weight" numeric(5, 2) DEFAULT '1' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competency_frameworks" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"rating_scale" integer DEFAULT 5 NOT NULL,
	"levels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kpi_definitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"unit" text,
	"target" numeric(10, 2),
	"weight" numeric(5, 2) DEFAULT '1' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_cycle_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"cycle_id" integer NOT NULL,
	"subject_id" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"relationship" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"submitted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_cycle_responses" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"responses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overall_rating" integer,
	"submitted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_cycles" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT '360' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"is_anonymous" boolean DEFAULT true NOT NULL,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"purpose" text NOT NULL,
	"destination" text NOT NULL,
	"departure_date" text NOT NULL,
	"return_date" text NOT NULL,
	"flight_required" boolean DEFAULT false NOT NULL,
	"hotel_required" boolean DEFAULT false NOT NULL,
	"advance_required" boolean DEFAULT false NOT NULL,
	"advance_amount" numeric(15, 2),
	"estimated_cost" numeric(15, 2),
	"per_diem" numeric(15, 2),
	"itinerary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"manager_approver_id" text,
	"manager_approved_at" timestamp,
	"finance_approver_id" text,
	"finance_approved_at" timestamp,
	"rejection_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "career_paths" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"department" text,
	"levels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_career_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"path_id" integer,
	"current_level" integer DEFAULT 1 NOT NULL,
	"target_role" text,
	"target_date" text,
	"aspirations" text,
	"mentor_id" text,
	"milestones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signature_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"document_type" text NOT NULL,
	"document_url" text NOT NULL,
	"requested_by" text NOT NULL,
	"signers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp,
	"completed_at" timestamp,
	"audit_trail" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"leave_type_id" integer NOT NULL,
	"name" text NOT NULL,
	"accrual_type" text DEFAULT 'ANNUAL' NOT NULL,
	"accrual_rate" numeric(6, 2) NOT NULL,
	"max_balance" numeric(6, 2),
	"carry_forward_days" numeric(6, 2) DEFAULT '0' NOT NULL,
	"carry_forward_expiry_months" integer,
	"encashable" boolean DEFAULT false NOT NULL,
	"probation_restricted" boolean DEFAULT false NOT NULL,
	"gender_restriction" text,
	"applies_to" text DEFAULT 'ALL' NOT NULL,
	"effective_from" text NOT NULL,
	"effective_to" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "announcement_reads" (
	"id" serial PRIMARY KEY NOT NULL,
	"announcement_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"read_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salary_structure_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"basic_salary" numeric(15, 2) NOT NULL,
	"hra_percent" numeric(5, 2) DEFAULT '40' NOT NULL,
	"special_allowance" numeric(15, 2) DEFAULT '0',
	"medical_allowance" numeric(15, 2) DEFAULT '0',
	"travel_allowance" numeric(15, 2) DEFAULT '0',
	"other_allowances" numeric(15, 2) DEFAULT '0',
	"pf_deduction_percent" numeric(5, 2) DEFAULT '12',
	"professional_tax" numeric(10, 2) DEFAULT '200',
	"effective_from" text NOT NULL,
	"effective_to" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allowance_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"formula_type" text DEFAULT 'FIXED' NOT NULL,
	"value" numeric(10, 4),
	"cap" numeric(15, 2),
	"is_taxable" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investment_proofs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"declaration_id" integer NOT NULL,
	"category" text NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"description" text,
	"proof_url" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_declarations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"financial_year" text NOT NULL,
	"regime" text DEFAULT 'NEW' NOT NULL,
	"hra" numeric(15, 2) DEFAULT '0' NOT NULL,
	"lta" numeric(15, 2) DEFAULT '0' NOT NULL,
	"section_80c" numeric(15, 2) DEFAULT '0' NOT NULL,
	"section_80d" numeric(15, 2) DEFAULT '0' NOT NULL,
	"section_80g" numeric(15, 2) DEFAULT '0' NOT NULL,
	"home_loan_interest" numeric(15, 2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"verified_by" text,
	"verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"month" text NOT NULL,
	"total_amount" numeric(15, 2) NOT NULL,
	"employee_count" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"bank_file_url" text,
	"reference_no" text,
	"processed_at" timestamp,
	"created_by" text,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "announcements" DROP CONSTRAINT "announcements_author_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "idx_announcements_org";--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "title" text NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "target_type" text DEFAULT 'ALL' NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "target_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "publish_at" timestamp;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "status" text DEFAULT 'DRAFT' NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "read_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "attachment_urls" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "project_webhooks" ADD CONSTRAINT "project_webhooks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_webhooks" ADD CONSTRAINT "project_webhooks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_webhooks" ADD CONSTRAINT "project_webhooks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_project_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."project_webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_shift_assignments" ADD CONSTRAINT "employee_shift_assignments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_shift_assignments" ADD CONSTRAINT "employee_shift_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_shift_assignments" ADD CONSTRAINT "employee_shift_assignments_shift_id_shift_templates_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shift_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_roster_id_rosters_id_fk" FOREIGN KEY ("roster_id") REFERENCES "public"."rosters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_shift_id_shift_templates_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shift_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rosters" ADD CONSTRAINT "rosters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rosters" ADD CONSTRAINT "rosters_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_off_balances" ADD CONSTRAINT "comp_off_balances_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_off_balances" ADD CONSTRAINT "comp_off_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geofences" ADD CONSTRAINT "geofences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biometric_devices" ADD CONSTRAINT "biometric_devices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biometric_logs" ADD CONSTRAINT "biometric_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biometric_logs" ADD CONSTRAINT "biometric_logs_device_id_biometric_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."biometric_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biometric_logs" ADD CONSTRAINT "biometric_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_categories" ADD CONSTRAINT "course_categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_enrollments" ADD CONSTRAINT "course_enrollments_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_enrollments" ADD CONSTRAINT "course_enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_category_id_course_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."course_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_instructor_id_users_id_fk" FOREIGN KEY ("instructor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_attendance" ADD CONSTRAINT "training_attendance_program_id_training_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."training_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_attendance" ADD CONSTRAINT "training_attendance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_programs" ADD CONSTRAINT "training_programs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_programs" ADD CONSTRAINT "training_programs_instructor_id_users_id_fk" FOREIGN KEY ("instructor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_requisitions" ADD CONSTRAINT "job_requisitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_requisitions" ADD CONSTRAINT "job_requisitions_hiring_manager_id_users_id_fk" FOREIGN KEY ("hiring_manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_requisitions" ADD CONSTRAINT "job_requisitions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_requisitions" ADD CONSTRAINT "job_requisitions_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competencies" ADD CONSTRAINT "competencies_framework_id_competency_frameworks_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."competency_frameworks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_frameworks" ADD CONSTRAINT "competency_frameworks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kpi_definitions" ADD CONSTRAINT "kpi_definitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_cycle_requests" ADD CONSTRAINT "feedback_cycle_requests_cycle_id_feedback_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."feedback_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_cycle_requests" ADD CONSTRAINT "feedback_cycle_requests_subject_id_users_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_cycle_requests" ADD CONSTRAINT "feedback_cycle_requests_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_cycle_responses" ADD CONSTRAINT "feedback_cycle_responses_request_id_feedback_cycle_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."feedback_cycle_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_cycles" ADD CONSTRAINT "feedback_cycles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_cycles" ADD CONSTRAINT "feedback_cycles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_manager_approver_id_users_id_fk" FOREIGN KEY ("manager_approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_finance_approver_id_users_id_fk" FOREIGN KEY ("finance_approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_paths" ADD CONSTRAINT "career_paths_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_career_plans" ADD CONSTRAINT "employee_career_plans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_career_plans" ADD CONSTRAINT "employee_career_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_career_plans" ADD CONSTRAINT "employee_career_plans_path_id_career_paths_id_fk" FOREIGN KEY ("path_id") REFERENCES "public"."career_paths"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_career_plans" ADD CONSTRAINT "employee_career_plans_mentor_id_users_id_fk" FOREIGN KEY ("mentor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_policies" ADD CONSTRAINT "leave_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_policies" ADD CONSTRAINT "leave_policies_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_structure_templates" ADD CONSTRAINT "salary_structure_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_types" ADD CONSTRAINT "allowance_types_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_proofs" ADD CONSTRAINT "investment_proofs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_proofs" ADD CONSTRAINT "investment_proofs_declaration_id_tax_declarations_id_fk" FOREIGN KEY ("declaration_id") REFERENCES "public"."tax_declarations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_declarations" ADD CONSTRAINT "tax_declarations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_declarations" ADD CONSTRAINT "tax_declarations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_declarations" ADD CONSTRAINT "tax_declarations_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_webhooks_project_id" ON "project_webhooks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_webhooks_org_id" ON "project_webhooks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_deliveries_webhook_id" ON "webhook_deliveries" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_deliveries_delivered_at" ON "webhook_deliveries" USING btree ("delivered_at");--> statement-breakpoint
CREATE INDEX "idx_shift_assignments_user" ON "employee_shift_assignments" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_shift_assignments_org" ON "employee_shift_assignments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_shift_swaps_org_status" ON "shift_swap_requests" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_shift_swaps_requester" ON "shift_swap_requests" USING btree ("requester_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_shift_templates_org_name" ON "shift_templates" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_shift_templates_org_active" ON "shift_templates" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_roster_entries_roster" ON "roster_entries" USING btree ("roster_id");--> statement-breakpoint
CREATE INDEX "idx_roster_entries_user_date" ON "roster_entries" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "idx_rosters_org_week" ON "rosters" USING btree ("org_id","week_start");--> statement-breakpoint
CREATE INDEX "idx_comp_off_user" ON "comp_off_balances" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_overtime_org_status" ON "overtime_requests" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_overtime_user" ON "overtime_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_geofences_org_active" ON "geofences" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_biometric_devices_org" ON "biometric_devices" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_biometric_logs_org_device" ON "biometric_logs" USING btree ("org_id","device_id");--> statement-breakpoint
CREATE INDEX "idx_biometric_logs_user_time" ON "biometric_logs" USING btree ("user_id","punch_time");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_course_categories_org_name" ON "course_categories" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_course_enrollments_course_user" ON "course_enrollments" USING btree ("course_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_course_enrollments_user" ON "course_enrollments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_courses_org_status" ON "courses" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_training_attendance_program" ON "training_attendance" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_training_attendance_user" ON "training_attendance" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_training_programs_org_status" ON "training_programs" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_requisitions_org_status" ON "job_requisitions" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_requisitions_hiring_manager" ON "job_requisitions" USING btree ("hiring_manager_id");--> statement-breakpoint
CREATE INDEX "idx_competencies_framework" ON "competencies" USING btree ("framework_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_competency_frameworks_org_name" ON "competency_frameworks" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_kpi_definitions_org" ON "kpi_definitions" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_fb_cycle_req_cycle_sub_rev" ON "feedback_cycle_requests" USING btree ("cycle_id","subject_id","reviewer_id");--> statement-breakpoint
CREATE INDEX "idx_fb_cycle_requests_reviewer" ON "feedback_cycle_requests" USING btree ("reviewer_id","status");--> statement-breakpoint
CREATE INDEX "idx_fb_cycle_responses_request" ON "feedback_cycle_responses" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_cycles_org_status" ON "feedback_cycles" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_travel_requests_org_status" ON "travel_requests" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_travel_requests_user" ON "travel_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_career_paths_org" ON "career_paths" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_career_plans_user" ON "employee_career_plans" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_signature_requests_org_status" ON "signature_requests" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_signature_requests_requested_by" ON "signature_requests" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX "idx_leave_policies_org_type" ON "leave_policies" USING btree ("org_id","leave_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_announcement_reads_unique" ON "announcement_reads" USING btree ("announcement_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_announcement_reads_announcement" ON "announcement_reads" USING btree ("announcement_id");--> statement-breakpoint
CREATE INDEX "idx_announcement_reads_user" ON "announcement_reads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_salary_structure_templates_org" ON "salary_structure_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_salary_structure_templates_org_active" ON "salary_structure_templates" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_allowance_types_org_name" ON "allowance_types" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_allowance_types_org_category" ON "allowance_types" USING btree ("org_id","category");--> statement-breakpoint
CREATE INDEX "idx_investment_proofs_declaration" ON "investment_proofs" USING btree ("declaration_id");--> statement-breakpoint
CREATE INDEX "idx_tax_declarations_org_year" ON "tax_declarations" USING btree ("org_id","financial_year");--> statement-breakpoint
CREATE INDEX "idx_tax_declarations_user" ON "tax_declarations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_bank_transfers_org_month" ON "bank_transfers" USING btree ("org_id","month");--> statement-breakpoint
CREATE INDEX "idx_bank_transfers_org_status" ON "bank_transfers" USING btree ("org_id","status");--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_announcements_org_status" ON "announcements" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_announcements_org_pinned" ON "announcements" USING btree ("org_id","is_pinned");