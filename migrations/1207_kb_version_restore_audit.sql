-- 1207 — KB version restore audit
--
-- Records every restore operation with the actor, the source version number,
-- and the target page so the full restoration history is queryable and auditable.
--
-- Rollback: migrations/rollback/1207_kb_version_restore_audit.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."kb_version_restore_audit" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  "page_id" integer NOT NULL,
  "source_version_number" integer NOT NULL,
  "actor_user_id" text,
  "actor_membership_id" integer,
  "restored_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_kb_version_restore_audit_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_version_restore_audit_org_page"
  ON "public"."kb_version_restore_audit" ("org_id", "page_id", "restored_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_version_restore_audit_org_actor"
  ON "public"."kb_version_restore_audit" ("org_id", "actor_membership_id");
--> statement-breakpoint

ALTER TABLE "public"."kb_version_restore_audit"
  DROP CONSTRAINT IF EXISTS "kb_version_restore_audit_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."kb_version_restore_audit"
  ADD CONSTRAINT "kb_version_restore_audit_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_version_restore_audit"
  VALIDATE CONSTRAINT "kb_version_restore_audit_org_id_organizations_id_fk";
--> statement-breakpoint

ALTER TABLE "public"."kb_version_restore_audit"
  DROP CONSTRAINT IF EXISTS "fk_kb_version_restore_audit_page";
--> statement-breakpoint
ALTER TABLE "public"."kb_version_restore_audit"
  ADD CONSTRAINT "fk_kb_version_restore_audit_page"
  FOREIGN KEY ("page_id") REFERENCES "public"."kb_pages" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_version_restore_audit"
  VALIDATE CONSTRAINT "fk_kb_version_restore_audit_page";
--> statement-breakpoint

ALTER TABLE "public"."kb_version_restore_audit" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "public"."kb_version_restore_audit";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."kb_version_restore_audit"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

GRANT SELECT, INSERT ON "public"."kb_version_restore_audit" TO streamline_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "public"."kb_version_restore_audit_id_seq" TO streamline_app;
--> statement-breakpoint
