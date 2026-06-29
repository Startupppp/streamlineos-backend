CREATE TABLE "org_business_units" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "org_branches" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"business_unit_id" text,
	"manager_user_id" text,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"address" text,
	"city" text,
	"state" text,
	"country" text,
	"postal_code" text,
	"phone" text,
	"email" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "org_departments" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"branch_id" text,
	"head_user_id" text,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "org_teams" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"department_id" text,
	"lead_user_id" text,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"capacity" integer,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "org_locations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'OFFICE' NOT NULL,
	"address" text,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_cost_centers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_business_units" ADD CONSTRAINT "org_business_units_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "org_branches" ADD CONSTRAINT "org_branches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "org_branches" ADD CONSTRAINT "org_branches_business_unit_id_org_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."org_business_units"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "org_branches" ADD CONSTRAINT "org_branches_manager_user_id_users_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "org_departments" ADD CONSTRAINT "org_departments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "org_departments" ADD CONSTRAINT "org_departments_branch_id_org_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."org_branches"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "org_departments" ADD CONSTRAINT "org_departments_head_user_id_users_id_fk" FOREIGN KEY ("head_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "org_teams" ADD CONSTRAINT "org_teams_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "org_teams" ADD CONSTRAINT "org_teams_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "org_teams" ADD CONSTRAINT "org_teams_lead_user_id_users_id_fk" FOREIGN KEY ("lead_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "org_locations" ADD CONSTRAINT "org_locations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "org_cost_centers" ADD CONSTRAINT "org_cost_centers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_org_bus_org" ON "org_business_units" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_org_bus_org_code" ON "org_business_units" USING btree ("org_id","code");
--> statement-breakpoint
CREATE INDEX "idx_org_branches_org" ON "org_branches" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "idx_org_branches_bu" ON "org_branches" USING btree ("business_unit_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_org_branches_org_code" ON "org_branches" USING btree ("org_id","code");
--> statement-breakpoint
CREATE INDEX "idx_org_depts_org" ON "org_departments" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "idx_org_depts_branch" ON "org_departments" USING btree ("branch_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_org_depts_org_code" ON "org_departments" USING btree ("org_id","code");
--> statement-breakpoint
CREATE INDEX "idx_org_teams_org" ON "org_teams" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "idx_org_teams_dept" ON "org_teams" USING btree ("department_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_org_teams_org_code" ON "org_teams" USING btree ("org_id","code");
--> statement-breakpoint
CREATE INDEX "idx_org_locations_org" ON "org_locations" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "idx_org_cc_org" ON "org_cost_centers" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_org_cc_org_code" ON "org_cost_centers" USING btree ("org_id","code");
