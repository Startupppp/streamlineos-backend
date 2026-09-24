SET lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "build"."project_attachments" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" text NOT NULL,
  "project_id" integer NOT NULL,
  "uploaded_by_membership_id" integer NOT NULL,
  "file_name" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "storage_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at" timestamp with time zone,
  CONSTRAINT "uniq_project_attachments_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint
ALTER TABLE "build"."project_attachments"
  ADD CONSTRAINT "project_attachments_org_id_fkey"
  FOREIGN KEY ("org_id")
  REFERENCES "organizations" ("id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_attachments" VALIDATE CONSTRAINT "project_attachments_org_id_fkey";
--> statement-breakpoint
ALTER TABLE "build"."project_attachments"
  ADD CONSTRAINT "fk_project_attachments_org_project"
  FOREIGN KEY ("org_id", "project_id")
  REFERENCES "build"."projects" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_attachments" VALIDATE CONSTRAINT "fk_project_attachments_org_project";
--> statement-breakpoint
ALTER TABLE "build"."project_attachments"
  ADD CONSTRAINT "fk_project_attachments_org_uploader"
  FOREIGN KEY ("org_id", "uploaded_by_membership_id")
  REFERENCES "public"."organization_members" ("org_id", "id")
  ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_attachments" VALIDATE CONSTRAINT "fk_project_attachments_org_uploader";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_attachments_org_project_cursor"
  ON "build"."project_attachments" (org_id, project_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."project_attachments" TO streamline_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "build"."project_attachments_id_seq" TO streamline_app;
