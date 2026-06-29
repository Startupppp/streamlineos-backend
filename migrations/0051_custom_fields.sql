-- Migration: 0051_custom_fields
-- Adds custom_field_definitions table and custom_data JSONB columns on leads and deals.

CREATE TABLE IF NOT EXISTS "custom_field_definitions" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "entity_type" text NOT NULL,
  "name" text NOT NULL,
  "label" text NOT NULL,
  "field_type" text NOT NULL DEFAULT 'text',
  "options" jsonb,
  "is_required" boolean DEFAULT false,
  "is_active" boolean DEFAULT true,
  "sort_order" integer DEFAULT 0,
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "cfd_org_entity_name_idx"
  ON "custom_field_definitions"("org_id", "entity_type", "name");

CREATE INDEX IF NOT EXISTS "idx_cfd_org_entity"
  ON "custom_field_definitions"("org_id", "entity_type");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'leads' AND column_name = 'custom_data'
  ) THEN
    ALTER TABLE "leads" ADD COLUMN "custom_data" jsonb;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'deals' AND column_name = 'custom_data'
  ) THEN
    ALTER TABLE "deals" ADD COLUMN "custom_data" jsonb;
  END IF;
END $$;
