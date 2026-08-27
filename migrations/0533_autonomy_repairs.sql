-- Custom SQL migration file, put your code below! --

-- What the system may fix unattended, and every value it changed.
--
-- Phase 4 tickets 10 and 11. `AutonomyRepairService` has been querying both of
-- these tables since it was written and neither has ever existed: the Drizzle
-- declarations in `db/schema/crm/autonomy-repairs.ts` were added without a
-- migration, so every repair path throws at the first statement. The service is
-- registered in `autonomy.module.ts` and reachable, which is what made this
-- invisible -- the code is wired, the storage was never created.
--
-- Authored from the Drizzle declarations rather than from a diff tool, because
-- `drizzle-kit generate` is unusable in this repo. Column for column against
-- `autonomy-repairs.ts`.
--
-- Two tables and not one, for the reason the schema file records: a policy is a
-- GRANT over something off by default, and `autonomy_switches` is a VETO over
-- something on by default. Folding the opt-in into the veto table would invert
-- the default for every reader of it.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "autonomy_repair_policies" (
  "autonomy_repair_policy_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "repair_class" text NOT NULL,
  "enabled" boolean NOT NULL,
  -- Why the tenant said so, for whoever asks in six months.
  "reason" text,
  -- Plain text, never a foreign key to `users`: see 0223.
  "updated_by_user_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- NOT VALID then VALIDATE, so adding the constraint does not hold ACCESS
-- EXCLUSIVE on organizations while it runs.
ALTER TABLE "autonomy_repair_policies" ADD CONSTRAINT "fk_autonomy_repair_policies_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "autonomy_repair_policies" VALIDATE CONSTRAINT "fk_autonomy_repair_policies_org";

--> statement-breakpoint
-- One answer per class per tenant, and the target of the service's upsert.
-- A second row would make "may we repair this class" depend on which row the
-- query happened to read first.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_autonomy_repair_policies_class"
  ON "autonomy_repair_policies" ("organization_id", "repair_class");

--> statement-breakpoint
ALTER TABLE "autonomy_repair_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "autonomy_repair_policies";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "autonomy_repair_policies"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "autonomy_repair_policies" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "autonomy_repair_policies" TO streamline_app;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "autonomy_repairs" (
  "autonomy_repair_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  -- The batch this belongs to. One `autonomous_decisions` row covers however
  -- many values it changed, so four hundred identical malformed numbers are
  -- reviewed once; these rows are what make that batch undoable item by item.
  "autonomous_decision_id" text NOT NULL,
  "repair_class" text NOT NULL,
  -- The queue item this closed, so reverting can put it back.
  "finding_id" text,
  "party_id" text NOT NULL,
  -- The column rewritten, named as the party table spells it.
  "field" text NOT NULL,
  -- Nullable because the column it mirrors is, and because an undo has to be
  -- able to restore an absence.
  "previous_value" text,
  "repaired_value" text,
  "applied_at" timestamp DEFAULT now() NOT NULL,
  "reverted_at" timestamp,
  -- Plain text, never a foreign key to `users`: see 0223.
  "reverted_by_user_id" text,
  "reverted_reason" text
);

--> statement-breakpoint
ALTER TABLE "autonomy_repairs" ADD CONSTRAINT "fk_autonomy_repairs_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "autonomy_repairs" VALIDATE CONSTRAINT "fk_autonomy_repairs_org";

--> statement-breakpoint
-- The composite tenant key anything pointing back at a repair needs, so a
-- reference carries the organisation with it rather than trusting the id alone.
ALTER TABLE "autonomy_repairs" ADD CONSTRAINT "uniq_autonomy_repairs_org_id"
  UNIQUE ("organization_id", "autonomy_repair_id");

--> statement-breakpoint
-- The batch's own read: everything one decision changed, which is also the set
-- a whole-batch undo has to replay.
CREATE INDEX IF NOT EXISTS "idx_autonomy_repairs_decision"
  ON "autonomy_repairs" ("organization_id", "autonomous_decision_id");

--> statement-breakpoint
-- The measure: how much was repaired, per class, over a window.
CREATE INDEX IF NOT EXISTS "idx_autonomy_repairs_class"
  ON "autonomy_repairs" ("organization_id", "repair_class", "applied_at");

--> statement-breakpoint
-- What the system changed on one record, for that record's own screen.
CREATE INDEX IF NOT EXISTS "idx_autonomy_repairs_party"
  ON "autonomy_repairs" ("organization_id", "party_id", "applied_at");

--> statement-breakpoint
-- What is still standing. A batch reversal reads only the un-reverted rows, and
-- on a table where most rows are live forever the partial index is what keeps
-- that read from degrading into the full batch scan.
CREATE INDEX IF NOT EXISTS "idx_autonomy_repairs_live"
  ON "autonomy_repairs" ("organization_id", "autonomous_decision_id")
  WHERE reverted_at IS NULL;

--> statement-breakpoint
-- Without a policy the table is readable organisation-wide: grants arrive
-- through ALTER DEFAULT PRIVILEGES, so a missing policy is silent.
ALTER TABLE "autonomy_repairs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "autonomy_repairs";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "autonomy_repairs"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "autonomy_repairs" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "autonomy_repairs" TO streamline_app;

--> statement-breakpoint
ANALYZE "autonomy_repair_policies";
--> statement-breakpoint
ANALYZE "autonomy_repairs";
