-- 0156: RPT-001 — Sprint scope event log.
--
-- Today only *current* sprint membership is stored. When a ticket is moved between
-- sprints, the old sprint's numbers silently change and burndown reconstruction for
-- any past sprint becomes impossible.
--
-- This migration adds an append-only log of scope events:
--   added           — ticket entered a sprint
--   removed         — ticket left a sprint
--   estimate_changed— story-point estimate updated while in-sprint
--   completed       — ticket reached a "completed" workflow state
--   reopened        — ticket moved back from a completed state
--
-- The table is never updated or deleted (except via CASCADE when the org is dropped).
-- Backfill stamps an 'added' event for every ticket currently assigned to a sprint,
-- using the ticket's created_at as the proxy timestamp (the real assignment time is
-- not stored).

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TYPE "public"."sprint_scope_event_type" AS ENUM (
  'added',
  'removed',
  'estimate_changed',
  'completed',
  'reopened'
);

--> statement-breakpoint
CREATE TABLE "sprint_scope_events" (
  "id"              bigserial PRIMARY KEY NOT NULL,
  "org_id"          text NOT NULL,
  "sprint_id"       integer NOT NULL,
  "ticket_id"       integer NOT NULL,
  "event_type"      "sprint_scope_event_type" NOT NULL,
  "previous_points" integer,
  "new_points"      integer,
  "actor_id"        text,
  "created_at"      timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
ALTER TABLE "sprint_scope_events"
  ADD CONSTRAINT "sprint_scope_events_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "sprint_scope_events"
  VALIDATE CONSTRAINT "sprint_scope_events_org_id_organizations_id_fk";

--> statement-breakpoint
ALTER TABLE "sprint_scope_events"
  ADD CONSTRAINT "sprint_scope_events_sprint_id_sprints_id_fk"
  FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "sprint_scope_events"
  VALIDATE CONSTRAINT "sprint_scope_events_sprint_id_sprints_id_fk";

--> statement-breakpoint
ALTER TABLE "sprint_scope_events"
  ADD CONSTRAINT "sprint_scope_events_ticket_id_tickets_id_fk"
  FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "sprint_scope_events"
  VALIDATE CONSTRAINT "sprint_scope_events_ticket_id_tickets_id_fk";

--> statement-breakpoint
ALTER TABLE "sprint_scope_events"
  ADD CONSTRAINT "sprint_scope_events_actor_id_users_id_fk"
  FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE SET NULL NOT VALID;

--> statement-breakpoint
ALTER TABLE "sprint_scope_events"
  VALIDATE CONSTRAINT "sprint_scope_events_actor_id_users_id_fk";

--> statement-breakpoint
CREATE INDEX "idx_sprint_scope_events_org_sprint_created"
  ON "sprint_scope_events" ("org_id", "sprint_id", "created_at");

--> statement-breakpoint
CREATE INDEX "idx_sprint_scope_events_ticket"
  ON "sprint_scope_events" ("ticket_id");

--> statement-breakpoint
ALTER TABLE "sprint_scope_events" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "sprint_scope_events";

--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sprint_scope_events"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());

--> statement-breakpoint
-- Backfill: one 'added' event per ticket currently in a sprint.
-- story_points is used because that is what the existing burnup query reads.
-- created_at is used as a proxy for the actual assignment time (which was never stored).
SET statement_timeout = 0;

--> statement-breakpoint
INSERT INTO "sprint_scope_events" (
  "org_id",
  "sprint_id",
  "ticket_id",
  "event_type",
  "new_points",
  "created_at"
)
SELECT
  t.org_id,
  t.sprint_id,
  t.id,
  'added'::sprint_scope_event_type,
  t.story_points,
  t.created_at
FROM tickets t
INNER JOIN sprints s
  ON s.id = t.sprint_id
  AND s.org_id = t.org_id
WHERE t.sprint_id IS NOT NULL
  AND t.deleted_at IS NULL
  AND s.deleted_at IS NULL;
