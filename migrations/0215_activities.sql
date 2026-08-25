-- Custom SQL migration file, put your code below! --

-- Ticket 09. One activity model, and the participants on it.
--
-- This does NOT migrate the five activity stores that already exist
-- (deal_activities, lead_activities + lead_emails, tasks,
-- client_account_activities, crm_activities). The PRD puts downstream consumers
-- out of scope for phase 1, and rewriting five readers is how a walking skeleton
-- stops walking. This is the go-forward store the ingress seam writes into and
-- the timeline reads from.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activities" (
  "activity_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "kind" text NOT NULL,
  "occurred_at" timestamp DEFAULT now() NOT NULL,
  "subject" text,
  "body" text,
  "thread_id" text,
  "party_id" text,
  "deal_id" text,
  "subject_id" text,
  "actor_kind" text NOT NULL,
  "actor_user_id" text,
  "actor_label" text,
  "due_at" timestamp,
  "completed_at" timestamp,
  "assignee_user_id" text,
  "source" text DEFAULT 'manual' NOT NULL,
  "metadata" jsonb,
  "deleted_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_participants" (
  "activity_participant_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "activity_id" text NOT NULL,
  "party_id" text,
  "user_id" text,
  "address" text,
  "role" text DEFAULT 'attendee' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- A kind nothing renders is dead data, and a free-text kind is how five stores
-- ended up spelling "call" three ways.
ALTER TABLE "activities" ADD CONSTRAINT "chk_activities_kind"
  CHECK ("kind" IN ('call', 'email', 'meeting', 'note', 'task'));

--> statement-breakpoint
-- The same invariant the deal ledger holds: a human record without a person, or
-- a system one wearing someone's id, would make the timeline lie about what the
-- system did.
ALTER TABLE "activities" ADD CONSTRAINT "chk_activities_actor"
  CHECK (
    ("actor_kind" = 'human'  AND "actor_user_id" IS NOT NULL) OR
    ("actor_kind" = 'system' AND "actor_user_id" IS NULL)
  );

--> statement-breakpoint
-- An activity belongs to exactly one thing. Not a type-plus-id pair, and not
-- several at once — a row on two timelines is a row that gets counted twice.
ALTER TABLE "activities" ADD CONSTRAINT "chk_activities_one_anchor"
  CHECK (
    (("party_id" IS NOT NULL)::int + ("deal_id" IS NOT NULL)::int + ("subject_id" IS NOT NULL)::int) = 1
  );

--> statement-breakpoint
-- Only a task has a lifecycle; a due date on an email is a field nothing reads.
ALTER TABLE "activities" ADD CONSTRAINT "chk_activities_task_fields"
  CHECK ("kind" = 'task' OR ("due_at" IS NULL AND "completed_at" IS NULL));

--> statement-breakpoint
-- A participant is somebody: a known party, a colleague, or an address the CRM
-- has not resolved yet — which is what lets the ingress seam record a message
-- from someone it has never seen.
ALTER TABLE "activity_participants" ADD CONSTRAINT "chk_activity_participants_identity"
  CHECK ("party_id" IS NOT NULL OR "user_id" IS NOT NULL OR "address" IS NOT NULL);

--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "fk_activities_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "activities" VALIDATE CONSTRAINT "fk_activities_org";
--> statement-breakpoint
ALTER TABLE "activity_participants" ADD CONSTRAINT "fk_activity_participants_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "activity_participants" VALIDATE CONSTRAINT "fk_activity_participants_org";

--> statement-breakpoint
-- The tenant key the participant link points at.
ALTER TABLE "activities" ADD CONSTRAINT "uniq_activities_org_id"
  UNIQUE ("organization_id", "activity_id");
--> statement-breakpoint
ALTER TABLE "activity_participants" ADD CONSTRAINT "fk_activity_participants_activity"
  FOREIGN KEY ("organization_id", "activity_id")
  REFERENCES "activities"("organization_id", "activity_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "activity_participants" VALIDATE CONSTRAINT "fk_activity_participants_activity";

--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "fk_activities_party"
  FOREIGN KEY ("organization_id", "party_id")
  REFERENCES "business_parties"("organization_id", "party_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "activities" VALIDATE CONSTRAINT "fk_activities_party";
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "fk_activities_subject"
  FOREIGN KEY ("organization_id", "subject_id")
  REFERENCES "subjects"("organization_id", "subject_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "activities" VALIDATE CONSTRAINT "fk_activities_subject";

--> statement-breakpoint
-- The timeline reads, one per anchor. Ordered on (occurred_at, activity_id)
-- because a keyset cursor needs a total order and timestamps collide: importing
-- a mail folder writes hundreds in the same second.
CREATE INDEX IF NOT EXISTS "idx_activities_party_timeline"
  ON "activities" ("organization_id", "party_id", "occurred_at", "activity_id")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activities_deal_timeline"
  ON "activities" ("organization_id", "deal_id", "occurred_at", "activity_id")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activities_subject_timeline"
  ON "activities" ("organization_id", "subject_id", "occurred_at", "activity_id")
  WHERE "deleted_at" IS NULL;

--> statement-breakpoint
-- A person's own open tasks, which is a different read from a timeline.
CREATE INDEX IF NOT EXISTS "idx_activities_assignee_open"
  ON "activities" ("organization_id", "assignee_user_id", "due_at")
  WHERE "kind" = 'task' AND "completed_at" IS NULL AND "deleted_at" IS NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activities_thread"
  ON "activities" ("organization_id", "thread_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_participants_activity"
  ON "activity_participants" ("organization_id", "activity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_participants_party"
  ON "activity_participants" ("organization_id", "party_id", "activity_id");

--> statement-breakpoint
-- The RLS matrix. Without a policy each table is readable organisation-wide,
-- because grants arrive through ALTER DEFAULT PRIVILEGES and a missing policy is
-- silent — and these rows are the contents of people's mail.
ALTER TABLE "activities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "activities";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "activities"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "activities" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "activities" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "activity_participants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "activity_participants";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "activity_participants"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "activity_participants" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "activity_participants" TO streamline_app;

--> statement-breakpoint
ANALYZE "activities";
--> statement-breakpoint
ANALYZE "activity_participants";
