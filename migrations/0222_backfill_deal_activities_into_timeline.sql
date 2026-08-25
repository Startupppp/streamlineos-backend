-- Custom SQL migration file, put your code below! --

-- Deal activities, onto the one activity model.
--
-- Ticket 09 built `activities` and mounted it on parties and subjects, but the
-- deal path was never connected: `DealsActivitiesService.addActivity` wrote to
-- `deal_activities`, so a unified timeline on a deal would have rendered empty.
-- The write now goes through `ActivitiesService`, which leaves the history behind.
-- This copies it forward so nothing disappears from a screen it used to appear on.
--
-- `stage_change` is deliberately excluded. Ticket 08 models a transition in
-- `deal_stage_transitions` with an actor union and a CHECK constraint; copying it
-- here would give one event two homes that can disagree, and an activity is
-- something a person did rather than a change of state.
--
-- `document` becomes a `note` titled "Document", matching `deal-activity-kind.ts`.
-- The mapping lives in both places on purpose: that file is the runtime rule and
-- this is a one-time copy, and an unmapped type is skipped rather than guessed.
--
-- Idempotent: the metadata pointer carries the source row, and the WHERE NOT
-- EXISTS makes a re-run insert nothing.

SET lock_timeout = '5s';
SET statement_timeout = 0;

--> statement-breakpoint
INSERT INTO "activities" (
  "activity_id", "organization_id", "kind", "occurred_at", "subject", "body",
  "deal_id", "actor_kind", "actor_user_id", "source", "metadata", "created_at"
)
SELECT
  gen_random_uuid()::text,
  da."org_id",
  CASE lower(trim(da."type"))
    WHEN 'document' THEN 'note'
    ELSE lower(trim(da."type"))
  END,
  da."created_at",
  COALESCE(
    NULLIF(trim(da."subject"), ''),
    CASE WHEN lower(trim(da."type")) = 'document' THEN 'Document' END
  ),
  da."notes",
  da."deal_id"::text,
  'human',
  da."user_id",
  -- Distinguishes a copied row from one someone logged through the new path, so
  -- a reader can tell where a pre-migration entry came from.
  'legacy_deal_activity',
  jsonb_build_object('legacyDealActivityId', da."id", 'legacyType', da."type"),
  da."created_at"
FROM "deal_activities" da
WHERE lower(trim(da."type")) IN ('call', 'email', 'meeting', 'note', 'task', 'document')
  AND NOT EXISTS (
    SELECT 1 FROM "activities" a
    WHERE a."organization_id" = da."org_id"
      AND a."metadata" ->> 'legacyDealActivityId' = da."id"::text
  );

--> statement-breakpoint
ANALYZE "activities";
