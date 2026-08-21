-- Ticket 15: durable per-person capability. Until now a permission could only reach a person
-- through a role, so narrowing one person's access meant inventing a role — which the product
-- forbids — or handing them a whole rung of the ladder. `user_delegations` is temporary acting-for
-- and `user_module_access` can only take a module away, so neither could express this.
-- The tenant FK is composite on (org_id, organization_membership_id) so a grant can never point at
-- a membership in another organisation, and the unique key makes a duplicate grant unrepresentable.
SET lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_permission_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "organization_membership_id" integer NOT NULL,
  "permission_key" text NOT NULL,
  "scope" "data_scope" DEFAULT 'all' NOT NULL,
  "module_key" text NOT NULL,
  "granted_by_membership_id" integer,
  "reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_permission_grants"
  ADD CONSTRAINT "user_permission_grants_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade NOT VALID;
--> statement-breakpoint
ALTER TABLE "user_permission_grants" VALIDATE CONSTRAINT "user_permission_grants_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "user_permission_grants"
  ADD CONSTRAINT "user_permission_grants_permission_key_permissions_name_fk"
  FOREIGN KEY ("permission_key") REFERENCES "permissions"("name") ON DELETE cascade NOT VALID;
--> statement-breakpoint
ALTER TABLE "user_permission_grants" VALIDATE CONSTRAINT "user_permission_grants_permission_key_permissions_name_fk";
--> statement-breakpoint
ALTER TABLE "user_permission_grants"
  ADD CONSTRAINT "user_permission_grants_org_membership_fk"
  FOREIGN KEY ("org_id", "organization_membership_id")
  REFERENCES "organization_members"("org_id", "id") ON DELETE cascade NOT VALID;
--> statement-breakpoint
ALTER TABLE "user_permission_grants" VALIDATE CONSTRAINT "user_permission_grants_org_membership_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_user_permission_grants_membership_key"
  ON "user_permission_grants" ("org_id", "organization_membership_id", "permission_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_permission_grants_org_membership"
  ON "user_permission_grants" ("org_id", "organization_membership_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_permission_grants_org_module"
  ON "user_permission_grants" ("org_id", "module_key");
--> statement-breakpoint
-- Without a policy the table is readable organisation-wide, because grants arrive through
-- ALTER DEFAULT PRIVILEGES and a missing policy is silent.
ALTER TABLE "user_permission_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "user_permission_grants";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "user_permission_grants"
  FOR ALL USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "user_permission_grants" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_permission_grants" TO streamline_app;
