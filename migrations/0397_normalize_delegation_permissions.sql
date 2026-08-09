-- 0397: A delegation is the lifecycle header; delegated permissions are
-- canonical child edges. Backfill only catalog-backed keys because unknown
-- legacy keys were already ignored by access resolution.

SET statement_timeout = 0;
SET lock_timeout = '5s';

ALTER TABLE "user_delegations"
  ADD CONSTRAINT "uniq_user_delegations_org_delegation" UNIQUE ("org_id", "id");
--> statement-breakpoint

CREATE TABLE "user_delegation_permissions" (
  "org_id" text NOT NULL,
  "delegation_id" text NOT NULL,
  "permission_key" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "pk_user_delegation_permissions"
    PRIMARY KEY ("delegation_id", "permission_key"),
  CONSTRAINT "fk_user_delegation_permissions_org_delegation"
    FOREIGN KEY ("org_id", "delegation_id")
    REFERENCES "public"."user_delegations"("org_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "user_delegation_permissions_permission_key_permissions_name_fk"
    FOREIGN KEY ("permission_key")
    REFERENCES "public"."permissions"("name")
    ON DELETE RESTRICT
);
--> statement-breakpoint

INSERT INTO "user_delegation_permissions" (
  "org_id",
  "delegation_id",
  "permission_key"
)
SELECT DISTINCT
  delegation."org_id",
  delegation."id",
  delegated."permission_key"
FROM "user_delegations" AS delegation
CROSS JOIN LATERAL unnest(delegation."permissions")
  AS delegated("permission_key")
INNER JOIN "permissions" AS permission
  ON permission."name" = delegated."permission_key";
--> statement-breakpoint

CREATE INDEX "idx_user_delegation_permissions_org_delegation"
  ON "user_delegation_permissions" ("org_id", "delegation_id");
--> statement-breakpoint

CREATE INDEX "idx_user_delegation_permissions_key"
  ON "user_delegation_permissions" ("permission_key");
--> statement-breakpoint

ALTER TABLE "user_delegation_permissions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "user_delegation_permissions"
  FOR ALL
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

ALTER TABLE "user_delegations" DROP COLUMN "permissions";
