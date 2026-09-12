-- NEO-7 -- labour lite.
--
-- A twenty-person warehouse runs on somebody's memory of who is quick. This is
-- the smallest honest alternative: what each confirmation was, who did it, how
-- long it took, and a standard to compare it against.
--
-- **It is not payroll and cannot become payroll.** No column here is a rate, an
-- amount or an employee number, and nothing in `modules/inventory/labor/` writes
-- to a pay table -- `labor.spec.ts` asserts that as a ratchet. A warehouse
-- measuring pick rates and a business paying piece rates are different systems,
-- and the second needs grievance, correction and consent that a stock module has
-- no business improvising.
--
-- `distance_proxy` counts bin *changes*, not metres, and the column comment says
-- so. Engineered labour standards need a surveyed building and a time study;
-- neither exists here. Counting moves is defensible -- a picker who walked to
-- eight bins did more work than one who took eight units off one shelf -- and it
-- is honest about what it is. A column called "distance_metres" would be a
-- number somebody eventually puts in a performance review.
--
-- `standard_seconds` is stored on the row rather than recomputed at read time, so
-- a later change to the standard cannot silently restate last month's
-- performance.
--
-- The permission backfill at the end is the other half of adding
-- `inventory:labor:read` to the supervisor template. Role templates grant on role
-- *creation* only, so a new key never reaches an organisation that already
-- exists; without this the key is inert everywhere but on brand-new tenants. It
-- targets the module rungs by slug, the shape 0436 established.
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_labor_task_kind" AS ENUM ('PICK', 'PUTAWAY', 'COUNT', 'RECEIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_labor_records" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "warehouse_id" integer,
  "task_kind" "inv_labor_task_kind" NOT NULL,
  "task_id" integer NOT NULL,
  "task_line_id" integer,
  "user_id" text NOT NULL,
  "location_id" integer,
  "started_at" timestamp NOT NULL,
  "completed_at" timestamp NOT NULL,
  "units_done" numeric(18, 4) DEFAULT '0' NOT NULL,
  "scan_count" integer DEFAULT 0 NOT NULL,
  "distance_proxy" integer DEFAULT 0 NOT NULL,
  "standard_seconds" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_labor_records_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_inv_labor_records_window" CHECK ("completed_at" >= "started_at"),
  CONSTRAINT "chk_inv_labor_records_standard_positive" CHECK ("standard_seconds" > 0)
);
--> statement-breakpoint

COMMENT ON COLUMN "inv_labor_records"."distance_proxy" IS
  'Bin changes, not metres. A proxy for walking: engineered labour standards need a surveyed building and a time study, and neither exists here.';
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_labor_records" ADD CONSTRAINT "inv_labor_records_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_labor_records" ADD CONSTRAINT "inv_labor_records_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_labor_records" ADD CONSTRAINT "fk_inv_labor_records_warehouse_org"
    FOREIGN KEY ("org_id", "warehouse_id") REFERENCES "inv_warehouses"("org_id", "id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_labor_records" ADD CONSTRAINT "inv_labor_records_location_id_fk"
    FOREIGN KEY ("location_id") REFERENCES "inv_locations"("id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "inv_labor_records" VALIDATE CONSTRAINT "inv_labor_records_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_labor_records" VALIDATE CONSTRAINT "inv_labor_records_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_labor_records" VALIDATE CONSTRAINT "fk_inv_labor_records_warehouse_org";
--> statement-breakpoint
ALTER TABLE "inv_labor_records" VALIDATE CONSTRAINT "inv_labor_records_location_id_fk";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_labor_records_org_warehouse_completed"
  ON "inv_labor_records" ("org_id", "warehouse_id", "completed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_labor_records_org_user_completed"
  ON "inv_labor_records" ("org_id", "user_id", "completed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_labor_records_org_task"
  ON "inv_labor_records" ("org_id", "task_kind", "task_id");
--> statement-breakpoint

INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'inventory:labor:read', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('INVENTORY_MODULE_OWNER', 'INVENTORY_MODULE_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'inventory:labor:read')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" IN ('INVENTORY_MODULE_OWNER', 'INVENTORY_MODULE_ADMIN')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
