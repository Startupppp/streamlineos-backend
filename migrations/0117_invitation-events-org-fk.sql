SET statement_timeout = 0;
SET lock_timeout = '5s';

ALTER TABLE "invitation_events"
  ADD CONSTRAINT "invitation_events_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id")
  REFERENCES "public"."organizations"("id")
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint

ALTER TABLE "invitation_events"
  VALIDATE CONSTRAINT "invitation_events_org_id_organizations_id_fk";