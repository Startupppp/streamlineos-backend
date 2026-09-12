-- NEO-12 and NEO-14 -- dock appointments, and the optional waveless join.
--
-- ## The dock
--
-- The smallest thing that makes a dock schedulable: a door, a window, and a
-- refusal when two vehicles are booked into the same one. **Not a yard.** No
-- trailer, no parking bay, no gate move, no digital twin of the site. Half of one
-- of those would be worse than none, because a yard screen that cannot tell you
-- where a trailer is is a screen people stop looking at.
--
-- The collision rule is an **exclusion constraint**, not a check in the service,
-- and that is the whole reason this table earns its keep: two clerks booking the
-- same door at the same moment both pass a read, and only Postgres can settle it.
-- It needs `btree_gist` for the equality half of the operator class, and it
-- ignores cancelled and no-show rows - a slot somebody gave up is not a booking.
--
-- `asn_id` and `load_id` are an exclusive arc rather than a polymorphic pair
-- (backend/CLAUDE.md S3): each is a real foreign key with real integrity, and a
-- CHECK keeps at most one set. Both may be null - a slot booked before the
-- paperwork exists is an ordinary thing at a dock.
--
-- ## Waveless
--
-- `waveless_picking` defaults false and the default is the safe one: a wave a
-- picker is halfway through is a physical walk they have planned, and adding a
-- line to it behind them is a change to work in progress. `waveless_max_lines`
-- stops a wave growing without bound, which is the failure mode of every "just
-- add it to the current one" scheme.
SET lock_timeout = '5s';
--> statement-breakpoint

CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_dock_direction" AS ENUM ('INBOUND', 'OUTBOUND');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_dock_appointment_status" AS ENUM ('BOOKED', 'ARRIVED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_dock_doors" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "warehouse_id" integer NOT NULL,
  "code" text NOT NULL,
  "name" text,
  "direction" "inv_dock_direction",
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_dock_doors_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_dock_appointments" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "warehouse_id" integer NOT NULL,
  "door_id" integer NOT NULL,
  "direction" "inv_dock_direction" NOT NULL,
  "status" "inv_dock_appointment_status" DEFAULT 'BOOKED' NOT NULL,
  "window_start" timestamp NOT NULL,
  "window_end" timestamp NOT NULL,
  "carrier_name" text,
  "vehicle_ref" text,
  "reference" text,
  "asn_id" integer,
  "load_id" integer,
  "arrived_at" timestamp,
  "completed_at" timestamp,
  "notes" text,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_dock_appointments_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_inv_dock_appointments_window" CHECK ("window_end" > "window_start"),
  CONSTRAINT "chk_inv_dock_appointments_arc" CHECK (("asn_id" IS NULL) OR ("load_id" IS NULL))
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_dock_doors" ADD CONSTRAINT "inv_dock_doors_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_dock_doors" ADD CONSTRAINT "inv_dock_doors_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_dock_doors" ADD CONSTRAINT "fk_inv_dock_doors_warehouse_org"
    FOREIGN KEY ("org_id", "warehouse_id") REFERENCES "inv_warehouses"("org_id", "id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_dock_appointments" ADD CONSTRAINT "fk_inv_dock_appointments_door_org"
    FOREIGN KEY ("org_id", "door_id") REFERENCES "inv_dock_doors"("org_id", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_dock_appointments" ADD CONSTRAINT "fk_inv_dock_appointments_warehouse_org"
    FOREIGN KEY ("org_id", "warehouse_id") REFERENCES "inv_warehouses"("org_id", "id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_asn_id_fk"
    FOREIGN KEY ("asn_id") REFERENCES "inv_asns"("id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_dock_appointments" ADD CONSTRAINT "inv_dock_appointments_load_id_fk"
    FOREIGN KEY ("load_id") REFERENCES "inv_loads"("id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "inv_dock_doors" VALIDATE CONSTRAINT "inv_dock_doors_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_dock_doors" VALIDATE CONSTRAINT "inv_dock_doors_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_dock_doors" VALIDATE CONSTRAINT "fk_inv_dock_doors_warehouse_org";
--> statement-breakpoint
ALTER TABLE "inv_dock_appointments" VALIDATE CONSTRAINT "inv_dock_appointments_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_dock_appointments" VALIDATE CONSTRAINT "inv_dock_appointments_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_dock_appointments" VALIDATE CONSTRAINT "fk_inv_dock_appointments_door_org";
--> statement-breakpoint
ALTER TABLE "inv_dock_appointments" VALIDATE CONSTRAINT "fk_inv_dock_appointments_warehouse_org";
--> statement-breakpoint
ALTER TABLE "inv_dock_appointments" VALIDATE CONSTRAINT "inv_dock_appointments_asn_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_dock_appointments" VALIDATE CONSTRAINT "inv_dock_appointments_load_id_fk";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_dock_doors_org_warehouse_code"
  ON "inv_dock_doors" ("org_id", "warehouse_id", "code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_dock_doors_org_warehouse"
  ON "inv_dock_doors" ("org_id", "warehouse_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_dock_appointments_org_warehouse_window"
  ON "inv_dock_appointments" ("org_id", "warehouse_id", "window_start");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_dock_appointments_org_door_window"
  ON "inv_dock_appointments" ("org_id", "door_id", "window_start");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_dock_appointments_org_asn"
  ON "inv_dock_appointments" ("org_id", "asn_id") WHERE "asn_id" IS NOT NULL;
--> statement-breakpoint

-- The rule that makes the calendar worth having. Two bookings may not overlap on
-- one door; a cancelled or no-show row is not a booking and is excluded.
DO $$ BEGIN
  ALTER TABLE "inv_dock_appointments"
    ADD CONSTRAINT "excl_inv_dock_appointments_door_window"
    EXCLUDE USING gist (
      "org_id" WITH =,
      "door_id" WITH =,
      tsrange("window_start", "window_end", '[)') WITH &&
    ) WHERE ("status" IN ('BOOKED', 'ARRIVED', 'COMPLETED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "inv_settings" ADD COLUMN IF NOT EXISTS "waveless_picking" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "inv_settings" ADD COLUMN IF NOT EXISTS "waveless_max_lines" integer DEFAULT 50 NOT NULL;
--> statement-breakpoint

INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'inventory:dock:manage', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('INVENTORY_MODULE_OWNER', 'INVENTORY_MODULE_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'inventory:dock:manage')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" IN ('INVENTORY_MODULE_OWNER', 'INVENTORY_MODULE_ADMIN')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
