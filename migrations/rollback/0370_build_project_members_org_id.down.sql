SET statement_timeout = 0;

-- =============================================================================
-- 0370 DOWN — reverse the project_members tenant-scoping and index corrections
-- =============================================================================
-- Restores the exact prior shape. Dropping `org_id` is lossless here: every
-- value is derivable from `projects.org_id` via `project_id`, which is how the
-- UP migration backfilled it.
-- =============================================================================

-- Money columns are additive; the original numeric columns were never dropped,
-- so removing these is lossless.
ALTER TABLE "project_members" DROP COLUMN IF EXISTS "rate_currency";
ALTER TABLE "project_members" DROP COLUMN IF EXISTS "hourly_rate_minor";
ALTER TABLE "projects" DROP COLUMN IF EXISTS "budget_currency";
ALTER TABLE "projects" DROP COLUMN IF EXISTS "budget_minor";

DROP INDEX IF EXISTS "idx_projects_name_trgm";

CREATE INDEX IF NOT EXISTS "idx_tickets_org_project"
  ON "tickets" ("org_id", "project_id");

-- Narrowing bigint back to int4 is only safe while max(id) < 2147483647; the
-- guard aborts rather than truncating live ids.
DO $$
DECLARE
  t text;
  maxid bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['ticket_activity_log','ticket_comment_mentions','project_daily_snapshots','webhook_deliveries']
  LOOP
    EXECUTE format('SELECT COALESCE(max(id), 0) FROM %I', t) INTO maxid;
    IF maxid > 2147483647 THEN
      RAISE EXCEPTION 'Cannot narrow %.id to integer: max(id)=% exceeds int4.', t, maxid;
    END IF;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN id SET DATA TYPE integer', t);
    EXECUTE format('ALTER SEQUENCE %I AS integer', t || '_id_seq');
  END LOOP;
END $$;

ALTER TABLE "project_template_tickets" DROP CONSTRAINT IF EXISTS "uniq_project_template_tickets_org_id";
DROP INDEX IF EXISTS "idx_project_template_tickets_org_template";
ALTER TABLE "project_template_tickets" DROP CONSTRAINT IF EXISTS "project_template_tickets_org_id_organizations_id_fk";
ALTER TABLE "project_template_tickets" DROP COLUMN IF EXISTS "org_id";
ALTER TABLE "project_template_tickets" DROP COLUMN IF EXISTS "created_at";
ALTER TABLE "project_template_tickets" DROP COLUMN IF EXISTS "updated_at";

ALTER TABLE "project_members" DROP CONSTRAINT IF EXISTS "uniq_project_members_org_id";
DROP INDEX IF EXISTS "idx_project_members_org_user";
ALTER TABLE "project_members" DROP CONSTRAINT IF EXISTS "project_members_org_id_organizations_id_fk";
ALTER TABLE "project_members" DROP COLUMN IF EXISTS "org_id";
