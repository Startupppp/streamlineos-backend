SET lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."cell_ceiling_source" AS ENUM ('measured', 'vendor-declared');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TYPE "public"."cell_ceiling_source" ADD VALUE IF NOT EXISTS 'operational-judgment';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cell_capacity_measurements" (
  "measurement_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
  "cell_id" text NOT NULL,
  "limiting_resource" text NOT NULL,
  "used" double precision NOT NULL,
  "limit_value" double precision NOT NULL,
  "per_org_cost" double precision NOT NULL,
  "ceiling_source" "public"."cell_ceiling_source" NOT NULL,
  "measured_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cell_capacity_measurements_cell"
  ON "cell_capacity_measurements" ("cell_id", "measured_at");
