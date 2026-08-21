-- 0414: REG-004. The code emitted `build:ticket:assigned` (colon-separated) while
-- the catalog declared `project.task.assigned` (dot-separated), so neither key ever
-- resolved: the emitted key was undeclared and the declared key was never emitted.
-- Nine PROJECTS entries are renamed to the `build.*` namespace, matching §16 which
-- renamed the module to Build, and matching the dot notation the other 121 events use.
--
-- These are global catalog rows (org_id IS NULL). `seedGlobalCatalog` only INSERTS
-- rows it finds missing and never updates, so the new keys are seeded on next boot;
-- this migration removes the old rows that would otherwise linger unresolvable.
--
-- Safe to delete rather than rename: notification_preferences is empty (0 rows), so
-- no user preference references these keys, and there are 0 org-specific override
-- rows. Verified against the live database before writing this.
--
-- Historical `notifications` / `notification_deliveries` rows keep their old
-- event_key deliberately. They record what was actually sent at the time, and
-- rewriting delivery history to match a later rename would be a lie about the past.

SET lock_timeout = '5s';

DELETE FROM "notification_events"
WHERE "org_id" IS NULL
  AND "event_key" IN (
    'project.task.assigned',
    'project.task.due_soon',
    'project.task.overdue',
    'project.task.comment.mention',
    'project.task.status.changed',
    'project.sprint.started',
    'project.sprint.ending',
    'project.blocker.created',
    'project.approval.requested'
  );
