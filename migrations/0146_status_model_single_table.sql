-- 0146: SCH-002. Consolidate to a single status table per project.
-- custom_states was proven orphaned (tickets.state_id = NULL on 100% of rows).
-- project_statuses becomes the sole config table; tickets.status is FK-constrained to it.
--
-- Step order matters:
--   1. Backfill missing rows before the FK can be added without data loss.
--   2. Type the lifecycle column (text → state_group enum).
--   3. Add parent-side unique constraint, then the FK (NOT VALID → VALIDATE, §19 lock rule).
--   4. Drop the orphan column and table.

SET lock_timeout = '5s';
SET statement_timeout = 0;

-- 1. backfill any ticket status that has no configured project_statuses row
INSERT INTO project_statuses (org_id, project_id, name, "order", type)
SELECT DISTINCT t.org_id, t.project_id, t.status, 999, 'unstarted'
FROM tickets t
WHERE t.project_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM project_statuses s
    WHERE s.project_id = t.project_id AND s.name = t.status
  );
--> statement-breakpoint

-- 2. type the lifecycle column: text → state_group enum
ALTER TABLE project_statuses ALTER COLUMN type DROP DEFAULT;
--> statement-breakpoint

ALTER TABLE project_statuses ALTER COLUMN type TYPE state_group USING type::state_group;
--> statement-breakpoint

ALTER TABLE project_statuses ALTER COLUMN type SET DEFAULT 'unstarted'::state_group;
--> statement-breakpoint

-- 3. parent-side unique constraint (required for the FK target)
ALTER TABLE project_statuses ADD CONSTRAINT uniq_project_statuses_org_project_name
  UNIQUE (org_id, project_id, name);
--> statement-breakpoint

-- FK on tickets: NOT VALID first (avoids full table scan under lock), then VALIDATE
ALTER TABLE tickets ADD CONSTRAINT fk_tickets_status
  FOREIGN KEY (org_id, project_id, status)
  REFERENCES project_statuses (org_id, project_id, name)
  ON UPDATE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE tickets VALIDATE CONSTRAINT fk_tickets_status;
--> statement-breakpoint

-- 4. drop the orphan: tickets.state_id column and the custom_states table
ALTER TABLE tickets DROP COLUMN state_id;
--> statement-breakpoint

DROP TABLE custom_states;
