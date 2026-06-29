-- Onboarding document status enum
CREATE TYPE onboarding_doc_status AS ENUM ('PENDING', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED');
CREATE TYPE onboarding_document_status AS ENUM ('PENDING', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RE_UPLOAD_REQUESTED');
CREATE TYPE doc_audit_action AS ENUM ('UPLOADED', 'APPROVED', 'REJECTED', 'RE_UPLOAD_REQUESTED', 'RE_UPLOADED');

-- Document types configuration table
CREATE TABLE IF NOT EXISTS "document_types" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text,
  "is_mandatory" boolean DEFAULT true,
  "is_active" boolean DEFAULT true,
  "sort_order" integer DEFAULT 0,
  "applicable_roles" text[] DEFAULT '{}',
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX "idx_doc_types_org" ON "document_types"("org_id");

-- Employee onboarding documents
CREATE TABLE IF NOT EXISTS "onboarding_documents" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "document_type_id" integer NOT NULL REFERENCES "document_types"("id"),
  "file_url" text NOT NULL,
  "file_name" text NOT NULL,
  "file_size" integer,
  "mime_type" text,
  "version" integer DEFAULT 1,
  "status" onboarding_document_status DEFAULT 'SUBMITTED',
  "reviewed_by" text REFERENCES "users"("id"),
  "reviewed_at" timestamp,
  "remarks" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX "idx_onboarding_docs_user" ON "onboarding_documents"("user_id");
CREATE INDEX "idx_onboarding_docs_org" ON "onboarding_documents"("org_id");

-- Document audit log
CREATE TABLE IF NOT EXISTS "document_audit_logs" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "onboarding_document_id" integer NOT NULL REFERENCES "onboarding_documents"("id"),
  "action" doc_audit_action NOT NULL,
  "performed_by" text NOT NULL REFERENCES "users"("id"),
  "remarks" text,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now()
);

-- Add new columns to users table
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "is_profile_picture_required" boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS "onboarding_doc_status" onboarding_doc_status DEFAULT 'PENDING';
