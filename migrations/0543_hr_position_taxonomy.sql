-- c23-02: HR position taxonomy lookup tables.
-- Creates hr_position_statuses and hr_position_transitions, seeds the four
-- legacy enum values for every existing organisation so no tenant loses a
-- state, then guards that every hr_positions row's status is present in the
-- seeded lookup for its org.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE "hr_position_statuses" (
  "id"              integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id"          text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "name"            text NOT NULL,
  "order"           integer NOT NULL DEFAULT 0,
  "color"           text,
  "lifecycle_group" state_group NOT NULL DEFAULT 'unstarted',
  "is_active"       boolean NOT NULL DEFAULT true,
  "created_at"      timestamp NOT NULL DEFAULT now(),
  "updated_at"      timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_hr_position_statuses_org_id"   UNIQUE ("org_id", "id"),
  CONSTRAINT "uniq_hr_position_statuses_org_name" UNIQUE ("org_id", "name")
);

--> statement-breakpoint
CREATE INDEX "idx_hr_position_statuses_org" ON "hr_position_statuses" ("org_id");

--> statement-breakpoint
ALTER TABLE "hr_position_statuses" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "hr_position_statuses";

--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "hr_position_statuses"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

--> statement-breakpoint
REVOKE ALL ON "hr_position_statuses" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "hr_position_statuses" TO streamline_app;

--> statement-breakpoint
ANALYZE "hr_position_statuses";

--> statement-breakpoint
CREATE TABLE "hr_position_transitions" (
  "id"               integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id"           text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "from_status_id"   integer REFERENCES "hr_position_statuses"("id") ON DELETE CASCADE,
  "to_status_id"     integer NOT NULL REFERENCES "hr_position_statuses"("id") ON DELETE CASCADE,
  "name"             text,
  "requires_approval" boolean NOT NULL DEFAULT false,
  "required_fields"  jsonb NOT NULL DEFAULT '[]'::jsonb,
  "allowed_roles"    jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_by"       text REFERENCES users(id) ON DELETE SET NULL,
  "created_at"       timestamp NOT NULL DEFAULT now(),
  "updated_at"       timestamp NOT NULL DEFAULT now(),
  "deleted_at"       timestamp,
  CONSTRAINT "uniq_hr_position_transitions_org_id" UNIQUE ("org_id", "id")
);

--> statement-breakpoint
CREATE INDEX "idx_hr_position_transitions_org"  ON "hr_position_transitions" ("org_id") WHERE deleted_at IS NULL;

--> statement-breakpoint
CREATE INDEX "idx_hr_position_transitions_from" ON "hr_position_transitions" ("from_status_id");

--> statement-breakpoint
CREATE INDEX "idx_hr_position_transitions_to"   ON "hr_position_transitions" ("to_status_id");

--> statement-breakpoint
ALTER TABLE "hr_position_transitions" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "hr_position_transitions";

--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "hr_position_transitions"
  FOR ALL USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

--> statement-breakpoint
REVOKE ALL ON "hr_position_transitions" FROM PUBLIC;

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "hr_position_transitions" TO streamline_app;

--> statement-breakpoint
ANALYZE "hr_position_transitions";

--> statement-breakpoint
-- Seed: insert the four legacy enum values for every existing organisation.
-- Runs as the migration owner role (BYPASSRLS), so no tenant GUC is needed.
-- ON CONFLICT DO NOTHING is idempotent on re-runs.
INSERT INTO "hr_position_statuses" ("org_id", "name", "order", "lifecycle_group", "is_active")
SELECT
  o.id,
  vals.name,
  vals.ord,
  vals.grp::state_group,
  true
FROM organizations o
CROSS JOIN (
  VALUES
    ('open',   0, 'unstarted'),
    ('filled', 1, 'completed'),
    ('frozen', 2, 'started'),
    ('future', 3, 'unstarted')
) AS vals(name, ord, grp)
ON CONFLICT ON CONSTRAINT "uniq_hr_position_statuses_org_name" DO NOTHING;

--> statement-breakpoint
-- Guard: abort if any hr_positions row's status has no seeded lookup entry for
-- its org. Aborts the entire migration so nothing is partially applied.
-- Shape copied from migrations/0482_candidate_resume_column_drop.sql.
DO $$
DECLARE
  missing_count int;
BEGIN
  SELECT count(*) INTO missing_count
  FROM hr_positions p
  WHERE p.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM hr_position_statuses s
      WHERE s.org_id = p.org_id
        AND s.name   = p.status::text
    );

  IF missing_count > 0 THEN
    RAISE EXCEPTION
      'hr_position_statuses seed incomplete: % position(s) have a status value not present in hr_position_statuses for their org. Investigate before re-attempting.',
      missing_count;
  END IF;
END $$;
