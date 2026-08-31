-- ON DELETE SET NULL against a NOT NULL column cannot succeed: the delete fails 23502
-- instead of doing anything useful. Two constraints were in that state.
--
-- calendar_events.created_by_membership_id is NOT NULL by design — an event always has
-- a creator — and calendar-departed-actor.spec.ts asserts the FK blocks deletion so the
-- creator survives. 0831 converted it to SET NULL to unblock member departure, which
-- traded a 23001 (blocked, recoverable) for a 23502 (broken, unavoidable). Reverted to
-- NO ACTION: departure is refused with an actionable message naming the constraint, and
-- calendar events are handled explicitly through MEMBERSHIP_ARTIFACTS instead.
--
-- org_unit_members is a join table whose membership_id is NOT NULL. Per the constitution
-- a physical delete is correct for join rows, so the delete cascades. The departure path
-- already removes these rows explicitly; this makes any other delete path safe too.
SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE calendar_events
  DROP CONSTRAINT IF EXISTS fk_calendar_events_org_creator_membership;
--> statement-breakpoint

ALTER TABLE calendar_events
  ADD CONSTRAINT fk_calendar_events_org_creator_membership
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE calendar_events VALIDATE CONSTRAINT fk_calendar_events_org_creator_membership;
--> statement-breakpoint

ALTER TABLE org_unit_members
  DROP CONSTRAINT IF EXISTS fk_org_unit_members_membership;
--> statement-breakpoint

ALTER TABLE org_unit_members
  ADD CONSTRAINT fk_org_unit_members_membership
  FOREIGN KEY (org_id, membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint

ALTER TABLE org_unit_members VALIDATE CONSTRAINT fk_org_unit_members_membership;
--> statement-breakpoint

DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(r.relname || '.' || c.conname, ', ')
    INTO offenders
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_class f ON f.oid = c.confrelid
  WHERE c.contype = 'f'
    AND f.relname = 'organization_members'
    AND c.confdeltype = 'n'
    AND c.confdelsetcols IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM unnest(c.confdelsetcols) k(attnum)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE a.attnotnull
    );

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION '0839: ON DELETE SET NULL still targets a NOT NULL column on: %', offenders;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    WHERE r.relname = 'calendar_events'
      AND c.conname = 'fk_calendar_events_org_creator_membership'
      AND c.confdeltype = 'a'
      AND c.convalidated
  ) THEN
    RAISE EXCEPTION '0839: calendar_events creator FK is not a validated NO ACTION constraint';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    WHERE r.relname = 'org_unit_members'
      AND c.conname = 'fk_org_unit_members_membership'
      AND c.confdeltype = 'c'
      AND c.convalidated
  ) THEN
    RAISE EXCEPTION '0839: org_unit_members membership FK is not a validated CASCADE constraint';
  END IF;
END $$;
