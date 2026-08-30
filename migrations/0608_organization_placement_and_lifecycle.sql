-- Placement becomes a record rather than a column (c28 ticket 20), plus the
-- control-plane tables the organization lifecycle saga and the account-to-organization
-- discovery projection need (c28 tickets 24 and 25).
--
-- organization_placement carries no foreign key to organizations on purpose: placement is
-- reserved before the cell's organization row exists, and once the control plane and the
-- cell are separate databases the constraint cannot exist at all.
--
-- organizations.region is kept and still dual-written. Routing reads the placement record
-- only; the column is contracted in Phase 2 once a second cell has been exercised.

SET lock_timeout = '5s';

--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "organization_placement_status" AS ENUM ('ACTIVE', 'MOVING', 'READ_ONLY', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "organization_saga_kind" AS ENUM ('CREATE', 'ARCHIVE', 'RESTORE', 'EXPORT', 'OWNERSHIP_TRANSFER', 'PURGE_SCHEDULE', 'PURGE_CANCEL', 'LEGAL_HOLD', 'LEGAL_HOLD_RELEASE', 'TERMINAL_DELETE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "organization_saga_state" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'COMPENSATING', 'COMPENSATED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "organization_saga_step_state" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'COMPENSATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "organization_reservation_kind" AS ENUM ('ORGANIZATION_ID', 'SLUG', 'DOMAIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "organization_reservation_state" AS ENUM ('RESERVED', 'CLAIMED', 'RELEASED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "organization_purge_adapter_state" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'NOT_APPLICABLE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_placement" (
  "organization_id" text PRIMARY KEY NOT NULL,
  "region" text NOT NULL,
  "cell_id" text NOT NULL,
  "database_shard" text NOT NULL,
  "object_storage_region" text NOT NULL,
  "search_cluster" text NOT NULL,
  "placement_version" integer DEFAULT 1 NOT NULL,
  "write_fence_token" text NOT NULL,
  "lease_expires_at" timestamp with time zone NOT NULL,
  "status" "organization_placement_status" DEFAULT 'ACTIVE' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_organization_placement_cell" ON "organization_placement" ("cell_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_organization_placement_region" ON "organization_placement" ("region");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_organization_placement_lease" ON "organization_placement" ("lease_expires_at");

--> statement-breakpoint
INSERT INTO "organization_placement" (
  "organization_id", "region", "cell_id", "database_shard",
  "object_storage_region", "search_cluster", "placement_version",
  "write_fence_token", "lease_expires_at", "status"
)
SELECT
  o."id",
  COALESCE(o."region", 'primary'),
  'legacy-1',
  'primary',
  COALESCE(o."region", 'primary'),
  'primary',
  1,
  gen_random_uuid()::text,
  now() + interval '24 hours',
  'ACTIVE'
FROM "organizations" o
ON CONFLICT ("organization_id") DO NOTHING;

--> statement-breakpoint
UPDATE "organizations" SET "region" = 'primary' WHERE "region" IS NULL;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_lifecycle_sagas" (
  "saga_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "kind" "organization_saga_kind" NOT NULL,
  "state" "organization_saga_state" DEFAULT 'PENDING' NOT NULL,
  "request_key" text NOT NULL,
  "actor_user_id" text,
  "from_status" text,
  "to_status" text,
  "last_error" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_org_lifecycle_sagas_request" ON "organization_lifecycle_sagas" ("request_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_lifecycle_sagas_org" ON "organization_lifecycle_sagas" ("organization_id","kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_lifecycle_sagas_state" ON "organization_lifecycle_sagas" ("state","started_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_saga_steps" (
  "step_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "saga_id" uuid NOT NULL,
  "step_name" text NOT NULL,
  "position" integer NOT NULL,
  "state" "organization_saga_step_state" DEFAULT 'PENDING' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "detail" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_saga_steps"
  ADD CONSTRAINT "fk_org_saga_steps_saga" FOREIGN KEY ("saga_id")
  REFERENCES "organization_lifecycle_sagas"("saga_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "organization_saga_steps" VALIDATE CONSTRAINT "fk_org_saga_steps_saga";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_org_saga_steps_saga_step" ON "organization_saga_steps" ("saga_id","step_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_saga_steps_saga" ON "organization_saga_steps" ("saga_id","position");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_reservations" (
  "reservation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" "organization_reservation_kind" NOT NULL,
  "value" text NOT NULL,
  "organization_id" text NOT NULL,
  "saga_id" uuid,
  "state" "organization_reservation_state" DEFAULT 'RESERVED' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "claimed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "organization_reservations"
  ADD CONSTRAINT "fk_org_reservations_saga" FOREIGN KEY ("saga_id")
  REFERENCES "organization_lifecycle_sagas"("saga_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "organization_reservations" VALIDATE CONSTRAINT "fk_org_reservations_saga";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_org_reservations_kind_value" ON "organization_reservations" ("kind","value");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_reservations_org" ON "organization_reservations" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_reservations_expiry" ON "organization_reservations" ("state","expires_at");

--> statement-breakpoint
INSERT INTO "organization_reservations" ("kind", "value", "organization_id", "state", "expires_at", "claimed_at")
SELECT 'SLUG', o."slug", o."id", 'CLAIMED', now() + interval '100 years', now()
FROM "organizations" o
WHERE o."slug" IS NOT NULL
ON CONFLICT ("kind", "value") DO NOTHING;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_organization_index" (
  "user_id" text NOT NULL,
  "org_id" text NOT NULL,
  "cell_id" text NOT NULL,
  "region" text NOT NULL,
  "organization_name" text NOT NULL,
  "organization_slug" text NOT NULL,
  "membership_role" text NOT NULL,
  "membership_status" text NOT NULL,
  "organization_status" text NOT NULL,
  "joined_at" timestamp with time zone,
  "projected_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pk_account_organization_index" PRIMARY KEY ("user_id","org_id")
);
--> statement-breakpoint
ALTER TABLE "account_organization_index"
  ADD CONSTRAINT "fk_account_org_index_user" FOREIGN KEY ("user_id")
  REFERENCES "users"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "account_organization_index" VALIDATE CONSTRAINT "fk_account_org_index_user";
--> statement-breakpoint
ALTER TABLE "account_organization_index"
  ADD CONSTRAINT "fk_account_org_index_org" FOREIGN KEY ("org_id")
  REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "account_organization_index" VALIDATE CONSTRAINT "fk_account_org_index_org";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_account_org_index_user" ON "account_organization_index" ("user_id","membership_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_account_org_index_org" ON "account_organization_index" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_account_org_index_projected" ON "account_organization_index" ("projected_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_purge_confirmations" (
  "confirmation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "purge_job_id" text NOT NULL,
  "adapter" text NOT NULL,
  "state" "organization_purge_adapter_state" DEFAULT 'PENDING' NOT NULL,
  "detail" text,
  "confirmed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_purge_confirmations"
  ADD CONSTRAINT "fk_org_purge_confirmations_org" FOREIGN KEY ("org_id")
  REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "organization_purge_confirmations" VALIDATE CONSTRAINT "fk_org_purge_confirmations_org";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_org_purge_confirmations_job_adapter" ON "organization_purge_confirmations" ("org_id","purge_job_id","adapter");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_purge_confirmations_org_state" ON "organization_purge_confirmations" ("org_id","state");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_legal_holds" (
  "hold_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "reason" text NOT NULL,
  "placed_by" text NOT NULL,
  "placed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "released_by" text,
  "released_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "organization_legal_holds"
  ADD CONSTRAINT "fk_org_legal_holds_org" FOREIGN KEY ("org_id")
  REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "organization_legal_holds" VALIDATE CONSTRAINT "fk_org_legal_holds_org";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_legal_holds_active" ON "organization_legal_holds" ("org_id","released_at");

--> statement-breakpoint
ALTER TABLE "account_organization_index" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "account_organization_index";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "account_organization_index"
  FOR ALL
  USING ("org_id" = app.current_org_id_or_null() OR "user_id" = app.current_user_id_or_null())
  WITH CHECK ("org_id" = app.current_org_id_or_null() OR "user_id" = app.current_user_id_or_null());
--> statement-breakpoint
REVOKE ALL ON "account_organization_index" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "account_organization_index" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "organization_purge_confirmations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_purge_confirmations";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "organization_purge_confirmations"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "organization_purge_confirmations" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "organization_purge_confirmations" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "organization_legal_holds" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_legal_holds";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "organization_legal_holds"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "organization_legal_holds" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "organization_legal_holds" TO streamline_app;

--> statement-breakpoint
REVOKE ALL ON "organization_placement" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "organization_placement" TO streamline_app;
--> statement-breakpoint
REVOKE ALL ON "organization_lifecycle_sagas" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "organization_lifecycle_sagas" TO streamline_app;
--> statement-breakpoint
REVOKE ALL ON "organization_saga_steps" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "organization_saga_steps" TO streamline_app;
--> statement-breakpoint
REVOKE ALL ON "organization_reservations" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "organization_reservations" TO streamline_app;
