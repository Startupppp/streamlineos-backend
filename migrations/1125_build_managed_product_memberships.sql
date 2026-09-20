SET lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "build"."managed_product_memberships" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" text NOT NULL,
  "managed_product_id" integer NOT NULL,
  "organization_membership_id" integer NOT NULL,
  "role" text NOT NULL DEFAULT 'member',
  "added_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_mp_members_org_product_member') THEN
    ALTER TABLE "build"."managed_product_memberships"
      ADD CONSTRAINT "uniq_mp_members_org_product_member"
      UNIQUE ("org_id", "managed_product_id", "organization_membership_id");
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mp_members_org_product"
  ON "build"."managed_product_memberships" ("org_id", "managed_product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mp_members_membership"
  ON "build"."managed_product_memberships" ("organization_membership_id");
--> statement-breakpoint
ALTER TABLE "build"."managed_product_memberships"
  ADD CONSTRAINT "managed_product_memberships_org_id_fkey"
  FOREIGN KEY ("org_id")
  REFERENCES "organizations" ("id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."managed_product_memberships"
  VALIDATE CONSTRAINT "managed_product_memberships_org_id_fkey";
--> statement-breakpoint
ALTER TABLE "build"."managed_product_memberships"
  ADD CONSTRAINT "fk_mp_members_org_product"
  FOREIGN KEY ("org_id", "managed_product_id")
  REFERENCES "build"."managed_products" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."managed_product_memberships"
  VALIDATE CONSTRAINT "fk_mp_members_org_product";
--> statement-breakpoint
ALTER TABLE "build"."managed_product_memberships"
  ADD CONSTRAINT "fk_mp_members_org_membership"
  FOREIGN KEY ("org_id", "organization_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."managed_product_memberships"
  VALIDATE CONSTRAINT "fk_mp_members_org_membership";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."managed_product_memberships" TO streamline_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "build"."managed_product_memberships_id_seq" TO streamline_app;
