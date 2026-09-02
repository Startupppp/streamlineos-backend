-- Three tenant anchors the Drizzle schema declares and the catalog does not carry.
--
-- `notifications.org_id`, `chat_message_reactions.org_id` and
-- `build.project_ticket_counters.org_id` are each declared
-- `.references(() => organizations.id, { onDelete: "cascade" })`, and none of the three
-- constraints exists. Measured on a database cold-built to head from zero.
--
-- Two of the three are covered transitively today and are declaration repairs:
--   * chat_message_reactions.message_id is NOT NULL behind
--     fk_chat_message_reactions_org_message -> chat_messages(org_id, id) ON DELETE CASCADE
--   * build.project_ticket_counters.project_id is NOT NULL behind
--     fk_project_ticket_counters_project -> build.projects(org_id, id) ON DELETE CASCADE
--
-- `notifications` is not. Its only tenant-bearing edge is
-- fk_notifications_recipient_membership (org_id, membership_id) -> organization_members,
-- and `membership_id` is NULLABLE, so an org-wide notification survives its own
-- organisation. Reproduced before this migration on a database at head:
--
--   INSERT INTO notifications (org_id, membership_id, ...) VALUES ('org_p1', NULL, ...);
--   DELETE FROM organizations WHERE id = 'org_p1';
--   SELECT count(*) FROM notifications WHERE org_id = 'org_p1';   -> 1
--
-- one row left pointing at an organisation that no longer exists. After this migration
-- that count is 0. `notifications` is RANGE-partitioned on created_at; Postgres installs
-- the constraint on the parent and propagates it to every partition, which was verified
-- on the same database before the file was written.
--
-- Adds no index: all three tables already carry an index leading with org_id
-- (check:tenant-indexes --db is 988/988 at head), which is what the cascade probe uses.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE chat_message_reactions
  ADD CONSTRAINT fk_chat_message_reactions_org
  FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE build.project_ticket_counters
  ADD CONSTRAINT fk_project_ticket_counters_org
  FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE notifications
  ADD CONSTRAINT fk_notifications_org
  FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE chat_message_reactions VALIDATE CONSTRAINT fk_chat_message_reactions_org;
--> statement-breakpoint

ALTER TABLE build.project_ticket_counters VALIDATE CONSTRAINT fk_project_ticket_counters_org;
--> statement-breakpoint

ALTER TABLE notifications VALIDATE CONSTRAINT fk_notifications_org;
--> statement-breakpoint

DO $$
DECLARE
  missing text;
  partitions int;
BEGIN
  SELECT string_agg(want.name, ', ') INTO missing
  FROM (VALUES
    ('fk_chat_message_reactions_org'),
    ('fk_project_ticket_counters_org'),
    ('fk_notifications_org')) AS want(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    WHERE con.conname = want.name AND con.contype = 'f' AND con.convalidated
      AND con.confrelid = 'public.organizations'::regclass
      AND con.confdeltype = 'c');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      '1024 left a tenant anchor missing, unvalidated, or not ON DELETE CASCADE: %', missing;
  END IF;

  SELECT count(*) INTO partitions
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_inherits i ON i.inhrelid = c.oid
  WHERE i.inhparent = 'public.notifications'::regclass
    AND con.contype = 'f'
    AND con.confrelid = 'public.organizations'::regclass;
  IF partitions = 0 THEN
    RAISE EXCEPTION
      '1024: fk_notifications_org did not propagate to any notifications partition';
  END IF;
  RAISE NOTICE '1024: fk_notifications_org propagated to % notifications partition(s)', partitions;
END
$$;
