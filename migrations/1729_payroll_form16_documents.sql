SET lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_form16_documents" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "financial_year" text NOT NULL,
  "user_membership_id" integer NOT NULL,
  "file_key" text NOT NULL,
  "file_name" text NOT NULL,
  "file_size_bytes" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'uploaded',
  "uploaded_by_membership_id" integer,
  "uploaded_at" timestamptz NOT NULL DEFAULT now(),
  "released_by_membership_id" integer,
  "released_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_payroll_form16_documents_status" CHECK ("status" IN ('uploaded', 'released')),
  CONSTRAINT "chk_payroll_form16_documents_fy" CHECK ("financial_year" ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT "chk_payroll_form16_documents_size" CHECK ("file_size_bytes" > 0),
  CONSTRAINT "chk_payroll_form16_documents_released" CHECK ("status" <> 'released' OR "released_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_payroll_form16_documents_org_id"
  ON "payroll_form16_documents" ("org_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_payroll_form16_documents_subject_fy"
  ON "payroll_form16_documents" ("org_id", "user_membership_id", "financial_year");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_form16_documents_org_fy_status"
  ON "payroll_form16_documents" ("org_id", "financial_year", "status");
--> statement-breakpoint
ALTER TABLE "payroll_form16_documents"
  ADD CONSTRAINT "fk_payroll_form16_documents_subject"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members"("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "payroll_form16_documents"
  VALIDATE CONSTRAINT "fk_payroll_form16_documents_subject";
--> statement-breakpoint
ALTER TABLE "payroll_form16_documents"
  ADD CONSTRAINT "fk_payroll_form16_documents_uploaded_by"
  FOREIGN KEY ("org_id", "uploaded_by_membership_id")
  REFERENCES "organization_members"("org_id", "id")
  ON DELETE SET NULL ("uploaded_by_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "payroll_form16_documents"
  VALIDATE CONSTRAINT "fk_payroll_form16_documents_uploaded_by";
--> statement-breakpoint
ALTER TABLE "payroll_form16_documents"
  ADD CONSTRAINT "fk_payroll_form16_documents_released_by"
  FOREIGN KEY ("org_id", "released_by_membership_id")
  REFERENCES "organization_members"("org_id", "id")
  ON DELETE SET NULL ("released_by_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "payroll_form16_documents"
  VALIDATE CONSTRAINT "fk_payroll_form16_documents_released_by";
--> statement-breakpoint
ALTER TABLE "payroll_form16_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "payroll_form16_documents";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "payroll_form16_documents"
  FOR ALL
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'streamline_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_form16_documents" TO streamline_app';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE "payroll_form16_documents_id_seq" TO streamline_app';
  END IF;
END $$;
