SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "build"."project_automation_runs" DROP CONSTRAINT IF EXISTS "fk_project_automation_runs_org_automation";
--> statement-breakpoint
ALTER TABLE "build"."project_automation_runs"
  ADD CONSTRAINT "fk_project_automation_runs_org_automation"
  FOREIGN KEY ("org_id", "automation_id")
  REFERENCES "build"."project_automations" ("org_id", "id")
  ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_automation_runs" DROP CONSTRAINT IF EXISTS "fk_project_automation_runs_org_ticket";
--> statement-breakpoint
ALTER TABLE "build"."project_automation_runs"
  ADD CONSTRAINT "fk_project_automation_runs_org_ticket"
  FOREIGN KEY ("org_id", "ticket_id")
  REFERENCES "build"."tickets" ("org_id", "id")
  ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_incidents" DROP CONSTRAINT IF EXISTS "fk_project_incidents_org_release";
--> statement-breakpoint
ALTER TABLE "build"."project_incidents"
  ADD CONSTRAINT "fk_project_incidents_org_release"
  FOREIGN KEY ("org_id", "release_id")
  REFERENCES "build"."project_releases" ("org_id", "id")
  ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."client_onboarding_items" DROP CONSTRAINT IF EXISTS "fk_client_onboarding_items_org_archiver_membership";
--> statement-breakpoint
ALTER TABLE "public"."client_onboarding_items"
  ADD CONSTRAINT "fk_client_onboarding_items_org_archiver_membership"
  FOREIGN KEY ("org_id", "archived_by_membership_id")
  REFERENCES "public"."organization_members" ("org_id", "id")
  ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_meetings" DROP CONSTRAINT IF EXISTS "fk_project_meetings_org_cycle";
--> statement-breakpoint
ALTER TABLE "build"."test_runs" DROP CONSTRAINT IF EXISTS "fk_test_runs_org_cycle";
--> statement-breakpoint
ALTER TABLE "build_events"."cycle_scope_events" DROP CONSTRAINT IF EXISTS "fk_sprint_scope_events_org_cycle";
