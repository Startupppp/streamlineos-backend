CREATE TABLE "project_custom_fields" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'text' NOT NULL,
	"options" text[],
	"required" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_releases" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"release_date" date,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"release_id" integer NOT NULL,
	"ticket_id" integer NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_checklist_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"checklist_id" integer NOT NULL,
	"text" text NOT NULL,
	"is_completed" boolean DEFAULT false NOT NULL,
	"assignee_id" text,
	"due_date" date,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_checklists" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" integer NOT NULL,
	"title" text DEFAULT 'Checklist' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_custom_field_values" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"field_id" integer NOT NULL,
	"value" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_custom_fields" ADD CONSTRAINT "project_custom_fields_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_custom_fields" ADD CONSTRAINT "project_custom_fields_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_releases" ADD CONSTRAINT "project_releases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_releases" ADD CONSTRAINT "project_releases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_releases" ADD CONSTRAINT "project_releases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_tickets" ADD CONSTRAINT "release_tickets_release_id_project_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."project_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_tickets" ADD CONSTRAINT "release_tickets_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_checklist_items" ADD CONSTRAINT "ticket_checklist_items_checklist_id_ticket_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."ticket_checklists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_checklist_items" ADD CONSTRAINT "ticket_checklist_items_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_checklists" ADD CONSTRAINT "ticket_checklists_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_checklists" ADD CONSTRAINT "ticket_checklists_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_custom_field_values" ADD CONSTRAINT "ticket_custom_field_values_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_custom_field_values" ADD CONSTRAINT "ticket_custom_field_values_field_id_project_custom_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."project_custom_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_custom_fields_project" ON "project_custom_fields" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_custom_fields_name" ON "project_custom_fields" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "idx_project_releases_project" ON "project_releases" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_releases_org_status" ON "project_releases" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_release_tickets" ON "release_tickets" USING btree ("release_id","ticket_id");--> statement-breakpoint
CREATE INDEX "idx_release_tickets_release" ON "release_tickets" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_checklist_items_checklist" ON "ticket_checklist_items" USING btree ("checklist_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_checklists_ticket" ON "ticket_checklists" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ticket_custom_field_values" ON "ticket_custom_field_values" USING btree ("ticket_id","field_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_custom_field_values_ticket" ON "ticket_custom_field_values" USING btree ("ticket_id");