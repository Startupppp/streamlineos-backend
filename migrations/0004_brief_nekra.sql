CREATE TYPE "public"."crm_activity_type" AS ENUM('deal_won', 'meeting', 'proposal', 'call', 'email', 'ticket', 'escalation');--> statement-breakpoint
CREATE TYPE "public"."crm_campaign_status" AS ENUM('active', 'paused', 'completed');--> statement-breakpoint
CREATE TYPE "public"."crm_deal_stage" AS ENUM('Discovery', 'Qualified', 'Proposal', 'Negotiation', 'Closed Won');--> statement-breakpoint
CREATE TYPE "public"."crm_event_status" AS ENUM('planning', 'confirmed', 'completed');--> statement-breakpoint
CREATE TYPE "public"."crm_health" AS ENUM('healthy', 'at_risk', 'critical');--> statement-breakpoint
CREATE TYPE "public"."crm_lead_status" AS ENUM('visitor', 'lead', 'mql', 'sql', 'opportunity');--> statement-breakpoint
CREATE TYPE "public"."crm_person_role" AS ENUM('sales_rep', 'csm', 'marketing');--> statement-breakpoint
CREATE TYPE "public"."crm_support_ticket_priority" AS ENUM('critical', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."crm_support_ticket_status" AS ENUM('new', 'in_progress', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."lead_activity_type" AS ENUM('call', 'email', 'whatsapp', 'meeting', 'site_visit');--> statement-breakpoint
CREATE TYPE "public"."lead_pipeline_status" AS ENUM('NEW', 'CONTACTED', 'INTERESTED', 'QUALIFIED', 'CONVERTED', 'LOST');--> statement-breakpoint
CREATE TYPE "public"."lead_source" AS ENUM('referral', 'campaign', 'cold_call', 'website', 'social_media', 'walk_in', 'other');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text,
	"target_id" text,
	"target_type" text,
	"metadata" jsonb,
	"ip_address" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"type" "crm_activity_type" NOT NULL,
	"message" text NOT NULL,
	"time" text NOT NULL,
	"person" text,
	"person_id" integer,
	"category" text DEFAULT 'sales' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "crm_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "crm_campaign_status" DEFAULT 'active',
	"leads" integer DEFAULT 0,
	"spend" numeric DEFAULT '0',
	"roi" numeric DEFAULT '0',
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "crm_companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"health" "crm_health" DEFAULT 'healthy',
	"revenue" numeric DEFAULT '0',
	"renewal_date" date,
	"renewal_value" numeric DEFAULT '0',
	"customer_since" text,
	"csm_id" integer,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "crm_content" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"views" integer DEFAULT 0,
	"leads" integer DEFAULT 0,
	"conv_rate" numeric DEFAULT '0',
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "crm_deals" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"company_name" text NOT NULL,
	"value" numeric NOT NULL,
	"stage" "crm_deal_stage" NOT NULL,
	"probability" integer DEFAULT 0,
	"close_date" date,
	"sales_rep_id" integer,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "crm_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"date" text NOT NULL,
	"type" text NOT NULL,
	"status" "crm_event_status" DEFAULT 'planning',
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "crm_leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"campaign_id" integer,
	"email" text,
	"name" text,
	"status" "crm_lead_status" DEFAULT 'lead',
	"channel" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "crm_monthly_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"month" text NOT NULL,
	"revenue" numeric DEFAULT '0',
	"mqls" integer DEFAULT 0,
	"retention" numeric DEFAULT '0',
	"csat" numeric DEFAULT '0',
	"ticket_volume" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "crm_people" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"initials" text NOT NULL,
	"role" "crm_person_role" NOT NULL,
	"title" text NOT NULL,
	"department" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"location" text,
	"join_date" text,
	"bio" text,
	"skills" text[],
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "crm_support_team_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"access" text NOT NULL,
	"avatar" text NOT NULL,
	"status" text DEFAULT 'online',
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "crm_support_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text,
	"priority" "crm_support_ticket_priority" DEFAULT 'medium',
	"status" "crm_support_ticket_status" DEFAULT 'new',
	"assignee_id" integer,
	"created_at" timestamp DEFAULT now(),
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "crm_team_performance" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"person_id" integer NOT NULL,
	"month" text NOT NULL,
	"value" numeric NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "department_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"department_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member',
	"joined_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "lead_activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"lead_id" integer NOT NULL,
	"type" "lead_activity_type" NOT NULL,
	"date" timestamp NOT NULL,
	"duration" integer,
	"subject" text,
	"location" text,
	"location_link" text,
	"message_summary" text,
	"notes" text,
	"outcome" text,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"whatsapp_number" text,
	"source" "lead_source" DEFAULT 'other',
	"campaign_id" integer,
	"status" "lead_pipeline_status" DEFAULT 'NEW' NOT NULL,
	"investment_interest" numeric,
	"potential_value" numeric,
	"notes" text,
	"assigned_to_id" text,
	"assigned_by_id" text,
	"assigned_at" timestamp,
	"converted_at" timestamp,
	"lost_reason" text,
	"company" text,
	"designation" text,
	"city" text,
	"tags" text[],
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"metric_type" text NOT NULL,
	"target_value" numeric NOT NULL,
	"current_value" numeric DEFAULT '0',
	"period" text DEFAULT 'daily',
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"set_by_id" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ticket_assignees" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"assigned_at" timestamp DEFAULT now(),
	"assigned_by" text
);
--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "auto_checked_out" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "payrolls" ADD COLUMN "overtime_type" text;--> statement-breakpoint
ALTER TABLE "payrolls" ADD COLUMN "overtime_days" numeric DEFAULT '0';--> statement-breakpoint
ALTER TABLE "payrolls" ADD COLUMN "overtime_hours" numeric DEFAULT '0';--> statement-breakpoint
ALTER TABLE "payrolls" ADD COLUMN "overtime_amount" numeric DEFAULT '0';--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "ticket_number" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_person_id_crm_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."crm_people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_campaigns" ADD CONSTRAINT "crm_campaigns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_companies" ADD CONSTRAINT "crm_companies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_companies" ADD CONSTRAINT "crm_companies_csm_id_crm_people_id_fk" FOREIGN KEY ("csm_id") REFERENCES "public"."crm_people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_content" ADD CONSTRAINT "crm_content_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_sales_rep_id_crm_people_id_fk" FOREIGN KEY ("sales_rep_id") REFERENCES "public"."crm_people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_events" ADD CONSTRAINT "crm_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_campaign_id_crm_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."crm_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_monthly_metrics" ADD CONSTRAINT "crm_monthly_metrics_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_people" ADD CONSTRAINT "crm_people_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_support_team_members" ADD CONSTRAINT "crm_support_team_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_support_tickets" ADD CONSTRAINT "crm_support_tickets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_support_tickets" ADD CONSTRAINT "crm_support_tickets_assignee_id_crm_people_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."crm_people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_team_performance" ADD CONSTRAINT "crm_team_performance_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_team_performance" ADD CONSTRAINT "crm_team_performance_person_id_crm_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."crm_people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_campaign_id_crm_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."crm_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_by_id_users_id_fk" FOREIGN KEY ("assigned_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_set_by_id_users_id_fk" FOREIGN KEY ("set_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_assignees" ADD CONSTRAINT "ticket_assignees_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_assignees" ADD CONSTRAINT "ticket_assignees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_assignees" ADD CONSTRAINT "ticket_assignees_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_logs_user_id" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_org_id" ON "audit_logs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_action" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_created_at" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_dept_members_dept_user" ON "department_members" USING btree ("department_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_lead_activities_lead" ON "lead_activities" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "idx_lead_activities_user" ON "lead_activities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_leads_org_status" ON "leads" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_leads_assigned_to" ON "leads" USING btree ("assigned_to_id");--> statement-breakpoint
CREATE INDEX "idx_targets_user_period" ON "targets" USING btree ("user_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ticket_assignees_ticket_user" ON "ticket_assignees" USING btree ("ticket_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_assignees_user_id" ON "ticket_assignees" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_attendance_user_id" ON "attendance" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_attendance_org_date" ON "attendance" USING btree ("org_id","date");--> statement-breakpoint
CREATE INDEX "idx_attendance_date" ON "attendance" USING btree ("date");--> statement-breakpoint
CREATE INDEX "idx_expenses_user_id" ON "expenses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_expenses_org_status" ON "expenses" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_leave_requests_user_id" ON "leave_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_leave_requests_org_status" ON "leave_requests" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_org_members_user_org" ON "organization_members" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_payrolls_org_month" ON "payrolls" USING btree ("org_id","month");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_members_project_user" ON "project_members" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_project_id" ON "tickets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_assignee_id" ON "tickets" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_sprint_id" ON "tickets" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_org_status" ON "tickets" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_users_email" ON "users" USING btree ("email");