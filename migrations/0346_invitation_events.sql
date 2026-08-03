SET statement_timeout = 0;
-- 0346 — invitation_events child table
-- Additive: existing invitations rows and timestamp columns are untouched.
-- Safe on empty DB: 0 rows to migrate.

CREATE TABLE "invitation_events" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "invitation_id" text NOT NULL,
  "event" text NOT NULL,
  "actor_membership_id" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "invitation_events_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint

ALTER TABLE "invitation_events"
  ADD CONSTRAINT "invitation_events_invitation_id_invitations_id_fk"
  FOREIGN KEY ("invitation_id")
  REFERENCES "public"."invitations"("id")
  ON DELETE CASCADE;
--> statement-breakpoint

CREATE INDEX "idx_invitation_events_org_invitation"
  ON "invitation_events" ("org_id", "invitation_id");
