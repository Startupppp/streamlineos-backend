ALTER TABLE "user_roles" ADD COLUMN "expires_at" timestamp;
ALTER TABLE "user_roles" ADD COLUMN "reason" text;

CREATE TABLE "resource_grants" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"principal_type" text DEFAULT 'user' NOT NULL,
	"principal_id" text NOT NULL,
	"permission_key" text NOT NULL,
	"granted_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE UNIQUE INDEX "uniq_resource_grants_all" ON "resource_grants" USING btree ("org_id","resource_type","resource_id","principal_type","principal_id","permission_key");
CREATE INDEX "idx_resource_grants_org_resource" ON "resource_grants" USING btree ("org_id","resource_type","resource_id");
CREATE INDEX "idx_resource_grants_principal" ON "resource_grants" USING btree ("org_id","principal_type","principal_id");
