SET lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."relocation_state" AS ENUM (
    'ACTIVE_SOURCE', 'SNAPSHOT', 'CATCH_UP', 'READ_ONLY_SOURCE',
    'VERIFY_TARGET', 'FLIP_PLACEMENT', 'ACTIVE_TARGET', 'RETIRE_SOURCE',
    'ROLLED_BACK', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."relocation_checksum_scope" AS ENUM ('table', 'partition', 'object', 'index');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."noisy_neighbour_action" AS ENUM ('THROTTLING_REVIEW', 'RELOCATION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."tenant_class" AS ENUM ('SHARED', 'DEDICATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_relocations" (
  "relocation_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
  "organization_id" text NOT NULL,
  "source_cell" text NOT NULL,
  "target_cell" text NOT NULL,
  "current_state" "public"."relocation_state" DEFAULT 'ACTIVE_SOURCE' NOT NULL,
  "placement_version_at_start" integer NOT NULL,
  "failure_reason" text,
  "rollback_reason" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_relocation_checksums" (
  "checksum_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
  "relocation_id" bigint NOT NULL,
  "scope_kind" "public"."relocation_checksum_scope" NOT NULL,
  "scope_name" text NOT NULL,
  "source_digest" text NOT NULL,
  "target_digest" text NOT NULL,
  "matched" boolean NOT NULL,
  "checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "placement_decisions" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "region" text NOT NULL,
  "tenant_class" "public"."tenant_class" NOT NULL,
  "admitted" boolean NOT NULL,
  "selected_cell_id" text,
  "rejections" jsonb NOT NULL,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "noisy_neighbour_reviews" (
  "id" text PRIMARY KEY NOT NULL,
  "cell_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "share_ratio" double precision NOT NULL,
  "consecutive_windows" integer NOT NULL,
  "action" "public"."noisy_neighbour_action" NOT NULL,
  "outcome" text,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "organization_relocation_checksums"
    ADD CONSTRAINT "organization_relocation_checksums_relocation_id_fk"
    FOREIGN KEY ("relocation_id") REFERENCES "public"."organization_relocations"("relocation_id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_org_relocation_active"
  ON "organization_relocations" ("organization_id") WHERE is_active = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_relocations_org_state"
  ON "organization_relocations" ("organization_id", "current_state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_relocations_state_started"
  ON "organization_relocations" ("current_state", "started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_relocation_checksums_relocation"
  ON "organization_relocation_checksums" ("relocation_id", "scope_kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_relocation_checksums_mismatches"
  ON "organization_relocation_checksums" ("relocation_id", "matched");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_placement_decisions_org"
  ON "placement_decisions" ("organization_id", "decided_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_placement_decisions_cell"
  ON "placement_decisions" ("selected_cell_id", "decided_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_noisy_neighbour_reviews_org"
  ON "noisy_neighbour_reviews" ("organization_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_noisy_neighbour_reviews_cell"
  ON "noisy_neighbour_reviews" ("cell_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_noisy_neighbour_reviews_unresolved"
  ON "noisy_neighbour_reviews" ("cell_id", "created_at") WHERE resolved_at IS NULL;
