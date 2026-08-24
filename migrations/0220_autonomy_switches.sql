-- Custom SQL migration file, put your code below! --

-- Ticket 13's kill switch, built here because ticket 12 must consult it before
-- it acts.
--
-- A product that acts without asking needs a way to be stopped that is not a
-- deploy. Two levels, one table: a NULL organization_id is the platform switch,
-- and one resolution path means there is no way to check the tenant's switch and
-- forget the operator's.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "autonomy_switches" (
  "autonomy_switch_id" text PRIMARY KEY NOT NULL,
  "organization_id" text,
  "kind" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "reason" text,
  "updated_by_user_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "autonomy_switches" ADD CONSTRAINT "chk_autonomy_switches_kind"
  CHECK ("kind" IN ('*', 'task.extracted', 'stage.advanced', 'party.created', 'activity.logged', 'quote.sent'));

--> statement-breakpoint
ALTER TABLE "autonomy_switches" ADD CONSTRAINT "fk_autonomy_switches_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "autonomy_switches" VALIDATE CONSTRAINT "fk_autonomy_switches_org";
--> statement-breakpoint
ALTER TABLE "autonomy_switches" ADD CONSTRAINT "fk_autonomy_switches_user"
  FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "autonomy_switches" VALIDATE CONSTRAINT "fk_autonomy_switches_user";

--> statement-breakpoint
-- One switch per (scope, kind). Two rows for the same pair would make the
-- effective state depend on which the query happened to read first.
--
-- NULLS NOT DISTINCT so the platform rows are covered too: by default Postgres
-- treats every NULL as unique, which would allow any number of conflicting
-- platform-wide switches for the same action.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_autonomy_switches_org_kind"
  ON "autonomy_switches" ("organization_id", "kind") NULLS NOT DISTINCT;

--> statement-breakpoint
-- Readable by the tenant it belongs to; the platform rows are readable by
-- everyone, because a tenant needs to know why their automation stopped.
ALTER TABLE "autonomy_switches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "autonomy_switches";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "autonomy_switches"
  FOR ALL USING (organization_id IS NULL OR organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "autonomy_switches" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "autonomy_switches" TO streamline_app;

--> statement-breakpoint
ANALYZE "autonomy_switches";
