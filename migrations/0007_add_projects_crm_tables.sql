-- Projects: Custom States, Cycles, Modules, Pages, Intake, Views, Relations
-- CRM: Lead Notes/Tasks/Emails, Templates, Scoring, Assignment Rules, SLA, Contacts, Organizations

DO $$ BEGIN
  CREATE TYPE "state_group" AS ENUM ('backlog', 'unstarted', 'started', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "cycle_status" AS ENUM ('draft', 'active', 'completed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "module_status" AS ENUM ('backlog', 'planned', 'in-progress', 'completed', 'paused', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "intake_status" AS ENUM ('pending', 'accepted', 'declined', 'duplicate');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "intake_source" AS ENUM ('manual', 'web_form', 'email');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "work_item_relation_type" AS ENUM ('blocks', 'blocked_by', 'duplicate_of', 'relates_to');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "view_layout" AS ENUM ('board', 'list', 'table', 'calendar', 'gantt');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "lead_email_direction" AS ENUM ('sent', 'received');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "lead_task_status" AS ENUM ('open', 'done');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "scoring_operator" AS ENUM ('eq', 'gt', 'lt', 'contains', 'in');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "assignment_rule_type" AS ENUM ('assign_user', 'round_robin');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "sla_applies_to" AS ENUM ('lead', 'deal', 'both');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "sla_priority" AS ENUM ('low', 'medium', 'high', 'urgent');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "org_size" AS ENUM ('1-10', '11-50', '51-200', '201-1000', '1000+');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Tickets: add new columns
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "start_date" date;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "due_date" date;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "state_id" integer;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "module_id" integer;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "cycle_id" integer;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "sequence_id" text;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "estimate" integer;

-- Leads: add score, sla, website
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "score" integer DEFAULT 0;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "sla_deadline" timestamp;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "website" text;

-- Deals: add linked references and SLA
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "linked_lead_id" integer REFERENCES "leads"("id");
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "linked_client_id" integer REFERENCES "clients"("id");
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "sla_deadline" timestamp;

-- Custom States
CREATE TABLE IF NOT EXISTS "custom_states" (
  "id" serial PRIMARY KEY,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "color" text NOT NULL DEFAULT '#3B82F6',
  "group" "state_group" NOT NULL,
  "sequence" integer NOT NULL DEFAULT 0,
  "is_default" boolean NOT NULL DEFAULT false,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_custom_states_project" ON "custom_states" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_custom_states_org" ON "custom_states" ("org_id");

-- Cycles
CREATE TABLE IF NOT EXISTS "cycles" (
  "id" serial PRIMARY KEY,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "description" text,
  "status" "cycle_status" NOT NULL DEFAULT 'draft',
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_cycles_project" ON "cycles" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_cycles_org_status" ON "cycles" ("org_id", "status");

-- Modules
CREATE TABLE IF NOT EXISTS "modules" (
  "id" serial PRIMARY KEY,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "description" text,
  "status" "module_status" NOT NULL DEFAULT 'backlog',
  "lead_id" text REFERENCES "users"("id"),
  "start_date" date,
  "end_date" date,
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_modules_project" ON "modules" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_modules_org" ON "modules" ("org_id");

-- Module Links
CREATE TABLE IF NOT EXISTS "module_links" (
  "id" serial PRIMARY KEY,
  "module_id" integer NOT NULL REFERENCES "modules"("id") ON DELETE CASCADE,
  "linked_module_id" integer NOT NULL REFERENCES "modules"("id") ON DELETE CASCADE,
  "created_at" timestamp DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_module_links" ON "module_links" ("module_id", "linked_module_id");

-- Pages
CREATE TABLE IF NOT EXISTS "pages" (
  "id" serial PRIMARY KEY,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "title" text NOT NULL,
  "content" jsonb,
  "icon" text,
  "cover_image" text,
  "is_public" boolean NOT NULL DEFAULT false,
  "is_pinned" boolean NOT NULL DEFAULT false,
  "parent_page_id" integer REFERENCES "pages"("id"),
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "updated_at" timestamp DEFAULT now(),
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_pages_project" ON "pages" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_pages_org" ON "pages" ("org_id");

-- Intake Items
CREATE TABLE IF NOT EXISTS "intake_items" (
  "id" serial PRIMARY KEY,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "title" text NOT NULL,
  "description" jsonb,
  "source" "intake_source" NOT NULL DEFAULT 'manual',
  "status" "intake_status" NOT NULL DEFAULT 'pending',
  "submitter_email" text,
  "linked_work_item_id" integer REFERENCES "tickets"("id"),
  "decline_reason" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_intake_items_project" ON "intake_items" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_intake_items_org_status" ON "intake_items" ("org_id", "status");

-- Work Item Relations
CREATE TABLE IF NOT EXISTS "work_item_relations" (
  "id" serial PRIMARY KEY,
  "work_item_id" integer NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
  "related_work_item_id" integer NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
  "relation_type" "work_item_relation_type" NOT NULL,
  "created_at" timestamp DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_work_item_relation" ON "work_item_relations" ("work_item_id", "related_work_item_id");
CREATE INDEX IF NOT EXISTS "idx_work_item_relations_item" ON "work_item_relations" ("work_item_id");
CREATE INDEX IF NOT EXISTS "idx_work_item_relations_related" ON "work_item_relations" ("related_work_item_id");

-- Project Views
CREATE TABLE IF NOT EXISTS "project_views" (
  "id" serial PRIMARY KEY,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "name" text NOT NULL,
  "filters" jsonb DEFAULT '{}',
  "group_by" text,
  "order_by" text,
  "layout_type" "view_layout" NOT NULL DEFAULT 'board',
  "is_pinned" boolean NOT NULL DEFAULT false,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_project_views_project" ON "project_views" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_project_views_org" ON "project_views" ("org_id");

-- Lead Notes
CREATE TABLE IF NOT EXISTS "lead_notes" (
  "id" serial PRIMARY KEY,
  "lead_id" integer NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "author_id" text NOT NULL REFERENCES "users"("id"),
  "body" text NOT NULL,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_lead_notes_lead" ON "lead_notes" ("lead_id");

-- Lead Tasks
CREATE TABLE IF NOT EXISTS "lead_tasks" (
  "id" serial PRIMARY KEY,
  "lead_id" integer NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "title" text NOT NULL,
  "due_date" date,
  "assignee_id" text REFERENCES "users"("id"),
  "status" "lead_task_status" NOT NULL DEFAULT 'open',
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_lead_tasks_lead" ON "lead_tasks" ("lead_id");

-- Lead Emails
CREATE TABLE IF NOT EXISTS "lead_emails" (
  "id" serial PRIMARY KEY,
  "lead_id" integer NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "direction" "lead_email_direction" NOT NULL,
  "subject" text,
  "body" text,
  "from_email" text NOT NULL,
  "to_email" text NOT NULL,
  "sent_at" timestamp DEFAULT now(),
  "message_id" text,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_lead_emails_lead" ON "lead_emails" ("lead_id");

-- CRM Email Templates
CREATE TABLE IF NOT EXISTS "crm_email_templates" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "subject" text NOT NULL,
  "body" text NOT NULL,
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_crm_email_templates_org" ON "crm_email_templates" ("org_id");

-- Lead Scoring Rules
CREATE TABLE IF NOT EXISTS "lead_scoring_rules" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "field" text NOT NULL,
  "operator" "scoring_operator" NOT NULL,
  "value" text NOT NULL,
  "points" integer NOT NULL,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_lead_scoring_rules_org" ON "lead_scoring_rules" ("org_id");

-- Lead Assignment Rules
CREATE TABLE IF NOT EXISTS "lead_assignment_rules" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "conditions" jsonb DEFAULT '[]',
  "assignment_type" "assignment_rule_type" NOT NULL,
  "assign_to_user_id" text REFERENCES "users"("id"),
  "round_robin_user_ids" jsonb DEFAULT '[]',
  "priority" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_lead_assignment_rules_org" ON "lead_assignment_rules" ("org_id");

-- Assignment Rule State
CREATE TABLE IF NOT EXISTS "assignment_rule_state" (
  "id" serial PRIMARY KEY,
  "rule_id" integer NOT NULL UNIQUE REFERENCES "lead_assignment_rules"("id") ON DELETE CASCADE,
  "last_assigned_index" integer NOT NULL DEFAULT 0
);

-- CRM SLA Policies
CREATE TABLE IF NOT EXISTS "crm_sla_policies" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "applies_to" "sla_applies_to" NOT NULL,
  "priority" "sla_priority" NOT NULL,
  "first_response_hours" integer NOT NULL,
  "resolution_hours" integer NOT NULL,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_crm_sla_org" ON "crm_sla_policies" ("org_id");

-- CRM Views
CREATE TABLE IF NOT EXISTS "crm_views" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "name" text NOT NULL,
  "entity_type" text NOT NULL,
  "filters" jsonb DEFAULT '{}',
  "sort_by" text,
  "sort_dir" text DEFAULT 'asc',
  "is_public" boolean NOT NULL DEFAULT false,
  "is_pinned" boolean NOT NULL DEFAULT false,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_crm_views_org" ON "crm_views" ("org_id");

-- Contacts
CREATE TABLE IF NOT EXISTS "contacts" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "email" text,
  "phone" text,
  "title" text,
  "department" text,
  "company" text,
  "organization_id" integer REFERENCES "crm_organizations"("id"),
  "linkedin_url" text,
  "twitter_url" text,
  "avatar_url" text,
  "lead_id" integer REFERENCES "leads"("id"),
  "deal_id" integer REFERENCES "deals"("id"),
  "tags" jsonb DEFAULT '[]',
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_contacts_org" ON "contacts" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_contacts_organization" ON "contacts" ("organization_id");

-- CRM Organizations
CREATE TABLE IF NOT EXISTS "crm_organizations" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "domain" text,
  "industry" text,
  "size" "org_size",
  "website" text,
  "linkedin_url" text,
  "description" text,
  "health_score" integer,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_crm_organizations_org" ON "crm_organizations" ("org_id");

-- Invoice AI Extractions
CREATE TABLE IF NOT EXISTS "invoice_ai_extractions" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "invoice_id" integer REFERENCES "invoices"("id"),
  "file_url" text NOT NULL,
  "extracted_data" jsonb,
  "status" text NOT NULL DEFAULT 'pending',
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_invoice_ai_extractions_org" ON "invoice_ai_extractions" ("org_id");

-- FK constraints for tickets new columns
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_state_id_fk" FOREIGN KEY ("state_id") REFERENCES "custom_states"("id") ON DELETE SET NULL;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_module_id_fk" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE SET NULL;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_cycle_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "cycles"("id") ON DELETE SET NULL;

-- Leads score index
CREATE INDEX IF NOT EXISTS "idx_leads_score" ON "leads" ("score");
