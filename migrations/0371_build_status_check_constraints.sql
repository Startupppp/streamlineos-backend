-- 0371 — Build: DB-level CHECK constraints on bare-text status columns
--
-- Rationale: brief §12 / CLAUDE.md §19 — prefer `text` + CHECK over pgEnum so the
-- allowed set stays extensible without a table rewrite. These five columns were bare
-- `text`/`varchar` with an application-only contract; the DB accepted any string.
--
-- Value sets are taken from the owning Zod schema, not guessed:
--   sprints             -> execution/dto/iterations.schemas.ts  updateSprintSchema
--   project_releases    -> core/dto/releases.schemas.ts
--   project_milestones  -> execution/dto/workspace.schemas.ts
--   pm_workspaces       -> pm-workspaces/dto  (["active","archived"])
--   webhook_deliveries  -> column default 'pending' + dispatch writes 'success'/'failed'
--
-- DELIBERATELY EXCLUDED (documented so a later audit does not "fix" them):
--   tickets.status          - legacy fallback for the user-definable custom_states FK.
--                             Its DTO accepts z.string(); a CHECK would reject values the
--                             API accepts today and break a working flow.
--   git_ticket_links.status - populated from external git providers; upstream vocabulary
--                             is not ours to constrain.
--
-- NOT VALID + VALIDATE is deliberate: ADD ... NOT VALID takes only a brief lock and does
-- not scan, then VALIDATE scans without blocking concurrent writes. On a populated
-- database a pre-existing out-of-set row makes VALIDATE fail loudly, which is correct —
-- it must not be silently accepted.

SET statement_timeout = 0;

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_sprints_status') THEN
    ALTER TABLE "sprints" ADD CONSTRAINT "chk_sprints_status"
      CHECK ("status" IN ('PLANNED','ACTIVE','COMPLETED')) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "sprints" VALIDATE CONSTRAINT "chk_sprints_status";

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_project_releases_status') THEN
    ALTER TABLE "project_releases" ADD CONSTRAINT "chk_project_releases_status"
      CHECK ("status" IN ('draft','released','archived')) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "project_releases" VALIDATE CONSTRAINT "chk_project_releases_status";

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_project_milestones_status') THEN
    ALTER TABLE "project_milestones" ADD CONSTRAINT "chk_project_milestones_status"
      CHECK ("status" IN ('PENDING','ACHIEVED','MISSED')) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "project_milestones" VALIDATE CONSTRAINT "chk_project_milestones_status";

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_pm_workspaces_status') THEN
    ALTER TABLE "pm_workspaces" ADD CONSTRAINT "chk_pm_workspaces_status"
      CHECK ("status" IN ('active','archived')) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "pm_workspaces" VALIDATE CONSTRAINT "chk_pm_workspaces_status";

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_webhook_deliveries_status') THEN
    ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "chk_webhook_deliveries_status"
      CHECK ("status" IN ('pending','success','failed')) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" VALIDATE CONSTRAINT "chk_webhook_deliveries_status";
