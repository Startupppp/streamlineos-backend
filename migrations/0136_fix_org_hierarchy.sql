CREATE TABLE IF NOT EXISTS "org_branches" (
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
CREATE TABLE IF NOT EXISTS "org_teams" (
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
ALTER TABLE "org_locations" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;
--> statement-breakpoint
ALTER TABLE "org_cost_centers" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.table_constraints
		WHERE constraint_name = 'org_branches_org_id_organizations_id_fk'
	) THEN
		ALTER TABLE "org_branches" ADD CONSTRAINT "org_branches_org_id_organizations_id_fk"
		FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.table_constraints
		WHERE constraint_name = 'org_branches_business_unit_id_org_business_units_id_fk'
	) THEN
		ALTER TABLE "org_branches" ADD CONSTRAINT "org_branches_business_unit_id_org_business_units_id_fk"
		FOREIGN KEY ("business_unit_id") REFERENCES "public"."org_business_units"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.table_constraints
		WHERE constraint_name = 'org_branches_manager_user_id_users_id_fk'
	) THEN
		ALTER TABLE "org_branches" ADD CONSTRAINT "org_branches_manager_user_id_users_id_fk"
		FOREIGN KEY ("manager_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.table_constraints
		WHERE constraint_name = 'org_teams_org_id_organizations_id_fk'
	) THEN
		ALTER TABLE "org_teams" ADD CONSTRAINT "org_teams_org_id_organizations_id_fk"
		FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.table_constraints
		WHERE constraint_name = 'org_teams_department_id_org_departments_id_fk'
	) THEN
		ALTER TABLE "org_teams" ADD CONSTRAINT "org_teams_department_id_org_departments_id_fk"
		FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.table_constraints
		WHERE constraint_name = 'org_teams_lead_user_id_users_id_fk'
	) THEN
		ALTER TABLE "org_teams" ADD CONSTRAINT "org_teams_lead_user_id_users_id_fk"
		FOREIGN KEY ("lead_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_branches_org" ON "org_branches" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_branches_bu" ON "org_branches" USING btree ("business_unit_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_org_branches_org_code" ON "org_branches" USING btree ("org_id","code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_teams_org" ON "org_teams" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_teams_dept" ON "org_teams" USING btree ("department_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_org_teams_org_code" ON "org_teams" USING btree ("org_id","code");
