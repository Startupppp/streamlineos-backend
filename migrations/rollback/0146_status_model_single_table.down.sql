-- Rollback for 0146_status_model_single_table
--
-- PARTIAL REVERSIBILITY WARNING:
-- Migration 0146 dropped the custom_states table. It was proven to contain
-- zero application-written rows (tickets.state_id was NULL on 100% of rows)
-- before the migration, so data loss is zero. This rollback recreates the
-- empty table and restores the state_id column on tickets with its original
-- FK. No rows are restored because none existed.
--
-- Additionally, the backfill INSERT in 0146 added rows to project_statuses
-- for any ticket status that lacked a configured row. This rollback does NOT
-- remove those rows; removing them risks breaking the FK that was also added
-- by 0146 and is now in place. The forward FK (fk_tickets_status) and the
-- unique constraint (uniq_project_statuses_org_project_name) are dropped
-- before the type is reverted.
--
-- Migration 0432 moved tickets and project_statuses from public to the build
-- schema. All references to those tables use build. accordingly.
-- custom_states is recreated in the public schema (it was never moved) and
-- projects is in build schema (FK reference updated accordingly).

SET lock_timeout = '5s';
SET statement_timeout = 0;

-- 1. Drop the FK on tickets (references project_statuses unique constraint).
ALTER TABLE "build"."tickets" DROP CONSTRAINT IF EXISTS fk_tickets_status;

-- 2. Drop the unique constraint on project_statuses.
ALTER TABLE "build"."project_statuses" DROP CONSTRAINT IF EXISTS uniq_project_statuses_org_project_name;

-- 3. Revert project_statuses.type from state_group enum back to text.
ALTER TABLE "build"."project_statuses" ALTER COLUMN type DROP DEFAULT;
ALTER TABLE "build"."project_statuses" ALTER COLUMN type
  TYPE text USING type::text;
ALTER TABLE "build"."project_statuses" ALTER COLUMN type SET DEFAULT 'unstarted';

-- 4. Recreate the custom_states table in public schema (empty — zero rows existed pre-migration).
CREATE TABLE IF NOT EXISTS "public"."custom_states" (
  "id"         serial PRIMARY KEY NOT NULL,
  "project_id" integer NOT NULL,
  "org_id"     text NOT NULL,
  "name"       text NOT NULL,
  "color"      text DEFAULT '#3B82F6' NOT NULL,
  "group"      "state_group" NOT NULL,
  "sequence"   integer DEFAULT 0 NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "custom_states_project_id_projects_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "build"."projects"("id") ON DELETE CASCADE,
  CONSTRAINT "custom_states_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_custom_states_project" ON "public"."custom_states" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_custom_states_org"     ON "public"."custom_states" ("org_id");

-- 5. Restore tickets.state_id column (was nullable, so no backfill needed).
ALTER TABLE "build"."tickets" ADD COLUMN IF NOT EXISTS "state_id" integer;

ALTER TABLE "build"."tickets" ADD CONSTRAINT "tickets_state_id_custom_states_id_fk"
  FOREIGN KEY ("state_id") REFERENCES "public"."custom_states"("id") ON DELETE SET NULL;
