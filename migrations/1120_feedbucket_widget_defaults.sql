SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."feedbucket_widgets" ADD COLUMN IF NOT EXISTS "default_project_id" integer;
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_widgets" ADD COLUMN IF NOT EXISTS "default_assignee_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_widgets" ADD COLUMN IF NOT EXISTS "assignee_rules" jsonb;
--> statement-breakpoint

DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('fk_feedbucket_widgets_org_default_project', '("org_id", "default_project_id") REFERENCES "build"."projects" ("org_id", "id") ON DELETE SET NULL'),
      ('fk_feedbucket_widgets_org_default_assignee', '("org_id", "default_assignee_membership_id") REFERENCES "organization_members" ("org_id", "id") ON DELETE SET NULL')
    ) AS t(name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = spec.name
         AND conrelid = 'build.feedbucket_widgets'::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE "build"."feedbucket_widgets" ADD CONSTRAINT %I FOREIGN KEY %s NOT VALID',
        spec.name, spec.definition
      );
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."feedbucket_widgets" VALIDATE CONSTRAINT "fk_feedbucket_widgets_org_default_project";
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_widgets" VALIDATE CONSTRAINT "fk_feedbucket_widgets_org_default_assignee";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_feedbucket_widgets_default_project" ON "build"."feedbucket_widgets" ("org_id", "default_project_id") WHERE "deleted_at" IS NULL;
