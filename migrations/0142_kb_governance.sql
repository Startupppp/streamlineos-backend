CREATE TABLE IF NOT EXISTS "kb_page_reviews" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "page_id" integer NOT NULL,
  "type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "requested_by_id" text,
  "reviewer_id" text,
  "due_at" timestamp with time zone,
  "decided_at" timestamp with time zone,
  "decision_note" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kb_import_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "source_type" text NOT NULL,
  "file_key" text,
  "status" text NOT NULL DEFAULT 'pending',
  "total_items" integer NOT NULL DEFAULT 0,
  "processed_items" integer NOT NULL DEFAULT 0,
  "succeeded_items" integer NOT NULL DEFAULT 0,
  "failed_items" integer NOT NULL DEFAULT 0,
  "duplicate_items" integer NOT NULL DEFAULT 0,
  "error_report" jsonb,
  "created_by_id" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kb_export_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "scope_type" text NOT NULL,
  "scope_id" integer,
  "format" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "file_key" text,
  "expires_at" timestamp with time zone,
  "created_by_id" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "kb_page_reviews"
  ADD CONSTRAINT "kb_page_reviews_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_reviews"
  ADD CONSTRAINT "kb_page_reviews_page_id_kb_pages_id_fk"
  FOREIGN KEY ("page_id") REFERENCES "kb_pages"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_reviews"
  ADD CONSTRAINT "kb_page_reviews_requested_by_id_users_id_fk"
  FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_page_reviews"
  ADD CONSTRAINT "kb_page_reviews_reviewer_id_users_id_fk"
  FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_import_jobs"
  ADD CONSTRAINT "kb_import_jobs_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_import_jobs"
  ADD CONSTRAINT "kb_import_jobs_created_by_id_users_id_fk"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_export_jobs"
  ADD CONSTRAINT "kb_export_jobs_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "kb_export_jobs"
  ADD CONSTRAINT "kb_export_jobs_created_by_id_users_id_fk"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_page_reviews_org_status_due" ON "kb_page_reviews" ("org_id", "status", "due_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_page_reviews_org_page" ON "kb_page_reviews" ("org_id", "page_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_import_jobs_org_created" ON "kb_import_jobs" ("org_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_export_jobs_org_created" ON "kb_export_jobs" ("org_id", "created_at" DESC);
