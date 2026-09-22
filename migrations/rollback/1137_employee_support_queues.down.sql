-- Rollback for migration 1137.
--
-- Destroys data, in two ways worth stating before anyone runs it:
--   * helpdesk_queues holds every tenant's per-queue SLA policy and escalation
--     target. Dropping the table discards all of it.
--   * helpdesk_tickets loses queue, the first-response and escalation stamps.
--     first_responded_at in particular is an observation of something that
--     happened; it cannot be recomputed.
--
-- `chk_hr_helpdesk_routing_target` and `fk_hr_helpdesk_routing_assignee_actor`
-- are DROPPED here and not restored, because 1137 introduced both. Its
-- `DROP CONSTRAINT IF EXISTS` before each `ADD` was idempotency boilerplate, not
-- the replacement of an older constraint — no earlier migration in the corpus
-- mentions either name.
--
-- The one step that can refuse is restoring assignee_user_id to NOT NULL. 1137
-- relaxed it so a rule could route to a queue instead of a person, so any
-- queue-routed rule now has a NULL there and pre-1137 code has no way to express
-- it. That is a decision for an operator, not for this file, so it is checked
-- FIRST and raises before anything is dropped.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  queue_routed bigint;
BEGIN
  SELECT count(*) INTO queue_routed
  FROM "hr_helpdesk_routing"
  WHERE "assignee_user_id" IS NULL;

  IF queue_routed > 0 THEN
    RAISE EXCEPTION
      'rollback 1137 refused: % hr_helpdesk_routing row(s) route to a queue and carry no assignee_user_id, which pre-1137 code cannot represent. Give each an assignee or delete it, then re-run this rollback.',
      queue_routed;
  END IF;
END $$;
--> statement-breakpoint

DROP TABLE IF EXISTS "helpdesk_queues";
--> statement-breakpoint

ALTER TABLE "hr_helpdesk_routing" DROP CONSTRAINT IF EXISTS "fk_hr_helpdesk_routing_assignee_actor";
--> statement-breakpoint
ALTER TABLE "hr_helpdesk_routing" DROP CONSTRAINT IF EXISTS "chk_hr_helpdesk_routing_target";
--> statement-breakpoint
ALTER TABLE "hr_helpdesk_routing" DROP COLUMN IF EXISTS "queue";
--> statement-breakpoint
ALTER TABLE "hr_helpdesk_routing" ALTER COLUMN "assignee_user_id" SET NOT NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_helpdesk_tickets_org_escalation_due";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_helpdesk_tickets_org_queue_status_created";
--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" DROP COLUMN IF EXISTS "escalation_level";
--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" DROP COLUMN IF EXISTS "escalated_at";
--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" DROP COLUMN IF EXISTS "first_responded_at";
--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" DROP COLUMN IF EXISTS "first_response_due_at";
--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" DROP COLUMN IF EXISTS "queue";
--> statement-breakpoint

-- Last: every column carrying the enum is gone by this point, so the type is
-- unreferenced and DROP TYPE will not refuse.
DROP TYPE IF EXISTS "helpdesk_queue";
