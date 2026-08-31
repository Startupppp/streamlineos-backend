SET lock_timeout = '5s';
--> statement-breakpoint
UPDATE build_events.ticket_activity_log t
SET user_membership_id = om.id
FROM public.organization_members om
WHERE om.user_id = t.user_id
  AND om.org_id = t.org_id
  AND t.user_id IS NOT NULL
  AND t.user_membership_id IS NULL;
--> statement-breakpoint
UPDATE build_events.sprint_scope_events t
SET actor_membership_id = om.id
FROM public.organization_members om
WHERE om.user_id = t.actor_id
  AND om.org_id = t.org_id
  AND t.actor_id IS NOT NULL
  AND t.actor_membership_id IS NULL;
--> statement-breakpoint
UPDATE build.workflow_transitions t
SET created_by_membership_id = om.id
FROM public.organization_members om
WHERE om.user_id = t.created_by
  AND om.org_id = t.org_id
  AND t.created_by IS NOT NULL
  AND t.created_by_membership_id IS NULL;
--> statement-breakpoint
DO $$
DECLARE
  unmapped bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM build_events.ticket_activity_log WHERE user_id IS NOT NULL AND user_membership_id IS NULL)
  + (SELECT count(*) FROM build_events.sprint_scope_events WHERE actor_id IS NOT NULL AND actor_membership_id IS NULL)
  + (SELECT count(*) FROM build.workflow_transitions WHERE created_by IS NOT NULL AND created_by_membership_id IS NULL)
  INTO unmapped;
  IF unmapped > 0 THEN
    RAISE EXCEPTION 'refusing to drop legacy actor columns: % row(s) still carry a legacy actor with no membership counterpart', unmapped;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "build_events"."ticket_activity_log" DROP COLUMN IF EXISTS "user_id";
--> statement-breakpoint
ALTER TABLE "build_events"."sprint_scope_events" DROP COLUMN IF EXISTS "actor_id";
--> statement-breakpoint
ALTER TABLE "build"."workflow_transitions" DROP COLUMN IF EXISTS "created_by";
