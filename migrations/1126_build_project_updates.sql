SET lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "build"."project_updates" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" text NOT NULL,
  "project_id" integer NOT NULL,
  "author_membership_id" integer NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at" timestamp with time zone,
  CONSTRAINT "uniq_project_updates_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint
ALTER TABLE "build"."project_updates"
  ADD CONSTRAINT "project_updates_org_id_fkey"
  FOREIGN KEY ("org_id")
  REFERENCES "organizations" ("id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_updates" VALIDATE CONSTRAINT "project_updates_org_id_fkey";
--> statement-breakpoint
ALTER TABLE "build"."project_updates"
  ADD CONSTRAINT "fk_project_updates_org_project"
  FOREIGN KEY ("org_id", "project_id")
  REFERENCES "build"."projects" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_updates" VALIDATE CONSTRAINT "fk_project_updates_org_project";
--> statement-breakpoint
ALTER TABLE "build"."project_updates"
  ADD CONSTRAINT "fk_project_updates_org_author"
  FOREIGN KEY ("org_id", "author_membership_id")
  REFERENCES "public"."organization_members" ("org_id", "id")
  ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_updates" VALIDATE CONSTRAINT "fk_project_updates_org_author";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_updates_org_project_cursor"
  ON "build"."project_updates" (org_id, project_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."project_updates" TO streamline_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "build"."project_updates_id_seq" TO streamline_app;
