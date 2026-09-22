-- Phase 2 / Workstream B / P0 #7 — QA bug consolidation, EXPAND phase.
--
-- Additive only. Creates the QA sidecar, the identity-mapping ledger, and the
-- work-item evidence pointer on test_run_results. Nothing is backfilled here
-- and nothing is dropped, so this file is safe to apply on its own and is
-- reversed by b-qa-bug-01-expand.rollback documented at the bottom of the
-- design note. The new FK on test_run_results is left NOT VALID on purpose:
-- it is validated in b-qa-bug-03-contract.sql, after the backfill has run.
--
-- Not a drizzle migration. This file carries no migrations/meta/_journal.json
-- entry and must be promoted into migrations/ by the owning session before it
-- can apply. It follows the seven rules enforced by
-- src/scripts/check-migration-discipline.mjs so that promotion is mechanical.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_tickets_org_project_id"
  ON "build"."tickets" ("org_id", "project_id", "id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."work_item_qa_details" (
  "org_id" text NOT NULL,
  "work_item_id" integer NOT NULL,
  "project_id" integer NOT NULL,
  "qa_state" "public"."bug_status" NOT NULL DEFAULT 'new',
  "severity" "public"."bug_severity" NOT NULL DEFAULT 'major',
  "steps_to_reproduce" text,
  "expected_result" text,
  "actual_result" text,
  "environment" text,
  "browser_device" text,
  "affected_release_id" integer,
  "fixed_release_id" integer,
  "qa_owner_user_id" text,
  "qa_owner_membership_id" integer,
  "linked_test_case_id" integer,
  "reopen_count" integer NOT NULL DEFAULT 0,
  "created_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "work_item_qa_details_pkey" PRIMARY KEY ("org_id", "work_item_id"),
  CONSTRAINT "chk_work_item_qa_details_reopen_count" CHECK ("reopen_count" >= 0)
);
--> statement-breakpoint

ALTER TABLE "build"."work_item_qa_details"
  DROP CONSTRAINT IF EXISTS "work_item_qa_details_org_id_fkey";
--> statement-breakpoint
ALTER TABLE "build"."work_item_qa_details"
  ADD CONSTRAINT "work_item_qa_details_org_id_fkey"
  FOREIGN KEY ("org_id")
  REFERENCES "public"."organizations" ("id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."work_item_qa_details"
  VALIDATE CONSTRAINT "work_item_qa_details_org_id_fkey";
--> statement-breakpoint

ALTER TABLE "build"."work_item_qa_details"
  DROP CONSTRAINT IF EXISTS "fk_work_item_qa_details_org_project_item";
--> statement-breakpoint
ALTER TABLE "build"."work_item_qa_details"
  ADD CONSTRAINT "fk_work_item_qa_details_org_project_item"
  FOREIGN KEY ("org_id", "project_id", "work_item_id")
  REFERENCES "build"."tickets" ("org_id", "project_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."work_item_qa_details"
  VALIDATE CONSTRAINT "fk_work_item_qa_details_org_project_item";
--> statement-breakpoint

ALTER TABLE "build"."work_item_qa_details"
  DROP CONSTRAINT IF EXISTS "fk_work_item_qa_details_org_affected_release";
--> statement-breakpoint
ALTER TABLE "build"."work_item_qa_details"
  ADD CONSTRAINT "fk_work_item_qa_details_org_affected_release"
  FOREIGN KEY ("org_id", "affected_release_id")
  REFERENCES "build"."project_releases" ("org_id", "id")
  ON DELETE SET NULL ("affected_release_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."work_item_qa_details"
  VALIDATE CONSTRAINT "fk_work_item_qa_details_org_affected_release";
--> statement-breakpoint

ALTER TABLE "build"."work_item_qa_details"
  DROP CONSTRAINT IF EXISTS "fk_work_item_qa_details_org_fixed_release";
--> statement-breakpoint
ALTER TABLE "build"."work_item_qa_details"
  ADD CONSTRAINT "fk_work_item_qa_details_org_fixed_release"
  FOREIGN KEY ("org_id", "fixed_release_id")
  REFERENCES "build"."project_releases" ("org_id", "id")
  ON DELETE SET NULL ("fixed_release_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."work_item_qa_details"
  VALIDATE CONSTRAINT "fk_work_item_qa_details_org_fixed_release";
--> statement-breakpoint

ALTER TABLE "build"."work_item_qa_details"
  DROP CONSTRAINT IF EXISTS "fk_work_item_qa_details_org_test_case";
--> statement-breakpoint
ALTER TABLE "build"."work_item_qa_details"
  ADD CONSTRAINT "fk_work_item_qa_details_org_test_case"
  FOREIGN KEY ("org_id", "linked_test_case_id")
  REFERENCES "build"."test_cases" ("org_id", "id")
  ON DELETE SET NULL ("linked_test_case_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."work_item_qa_details"
  VALIDATE CONSTRAINT "fk_work_item_qa_details_org_test_case";
--> statement-breakpoint

ALTER TABLE "build"."work_item_qa_details"
  DROP CONSTRAINT IF EXISTS "fk_work_item_qa_details_qa_owner_actor";
--> statement-breakpoint
ALTER TABLE "build"."work_item_qa_details"
  ADD CONSTRAINT "fk_work_item_qa_details_qa_owner_actor"
  FOREIGN KEY ("org_id", "qa_owner_membership_id")
  REFERENCES "public"."organization_members" ("org_id", "id")
  ON DELETE SET NULL ("qa_owner_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."work_item_qa_details"
  VALIDATE CONSTRAINT "fk_work_item_qa_details_qa_owner_actor";
--> statement-breakpoint

ALTER TABLE "build"."work_item_qa_details"
  DROP CONSTRAINT IF EXISTS "fk_work_item_qa_details_qa_owner_user";
--> statement-breakpoint
ALTER TABLE "build"."work_item_qa_details"
  ADD CONSTRAINT "fk_work_item_qa_details_qa_owner_user"
  FOREIGN KEY ("qa_owner_user_id")
  REFERENCES "public"."users" ("id")
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."work_item_qa_details"
  VALIDATE CONSTRAINT "fk_work_item_qa_details_qa_owner_user";
--> statement-breakpoint

ALTER TABLE "build"."work_item_qa_details"
  DROP CONSTRAINT IF EXISTS "fk_work_item_qa_details_created_by_user";
--> statement-breakpoint
ALTER TABLE "build"."work_item_qa_details"
  ADD CONSTRAINT "fk_work_item_qa_details_created_by_user"
  FOREIGN KEY ("created_by_user_id")
  REFERENCES "public"."users" ("id")
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."work_item_qa_details"
  VALIDATE CONSTRAINT "fk_work_item_qa_details_created_by_user";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_work_item_qa_details_org_project_state"
  ON "build"."work_item_qa_details" ("org_id", "project_id", "qa_state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_work_item_qa_details_org_project_severity"
  ON "build"."work_item_qa_details" ("org_id", "project_id", "severity");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_work_item_qa_details_org_test_case"
  ON "build"."work_item_qa_details" ("org_id", "linked_test_case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_work_item_qa_details_org_qa_owner_membership"
  ON "build"."work_item_qa_details" ("org_id", "qa_owner_membership_id");
--> statement-breakpoint

ALTER TABLE "build"."work_item_qa_details" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "build"."work_item_qa_details";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "build"."work_item_qa_details"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."work_item_qa_details" TO streamline_app;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."bug_work_item_map" (
  "org_id" text NOT NULL,
  "bug_id" integer NOT NULL,
  "project_id" integer NOT NULL,
  "legacy_bug_number" integer NOT NULL,
  "work_item_id" integer NOT NULL,
  "ticket_number" integer NOT NULL,
  "migration_batch" text NOT NULL DEFAULT 'b-qa-bug-02',
  "migrated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "bug_work_item_map_pkey" PRIMARY KEY ("org_id", "bug_id"),
  CONSTRAINT "uniq_bug_work_item_map_org_work_item" UNIQUE ("org_id", "work_item_id"),
  CONSTRAINT "uniq_bug_work_item_map_project_legacy_number" UNIQUE ("project_id", "legacy_bug_number")
);
--> statement-breakpoint

ALTER TABLE "build"."bug_work_item_map"
  DROP CONSTRAINT IF EXISTS "bug_work_item_map_org_id_fkey";
--> statement-breakpoint
ALTER TABLE "build"."bug_work_item_map"
  ADD CONSTRAINT "bug_work_item_map_org_id_fkey"
  FOREIGN KEY ("org_id")
  REFERENCES "public"."organizations" ("id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."bug_work_item_map"
  VALIDATE CONSTRAINT "bug_work_item_map_org_id_fkey";
--> statement-breakpoint

ALTER TABLE "build"."bug_work_item_map"
  DROP CONSTRAINT IF EXISTS "fk_bug_work_item_map_org_work_item";
--> statement-breakpoint
ALTER TABLE "build"."bug_work_item_map"
  ADD CONSTRAINT "fk_bug_work_item_map_org_work_item"
  FOREIGN KEY ("org_id", "work_item_id")
  REFERENCES "build"."tickets" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."bug_work_item_map"
  VALIDATE CONSTRAINT "fk_bug_work_item_map_org_work_item";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_bug_work_item_map_org_project"
  ON "build"."bug_work_item_map" ("org_id", "project_id", "legacy_bug_number");
--> statement-breakpoint

ALTER TABLE "build"."bug_work_item_map" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "build"."bug_work_item_map";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "build"."bug_work_item_map"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."bug_work_item_map" TO streamline_app;
--> statement-breakpoint

ALTER TABLE "build"."test_run_results"
  ADD COLUMN IF NOT EXISTS "linked_work_item_id" integer;
--> statement-breakpoint
ALTER TABLE "build"."test_run_results"
  DROP CONSTRAINT IF EXISTS "fk_test_run_results_org_work_item";
--> statement-breakpoint
ALTER TABLE "build"."test_run_results"
  ADD CONSTRAINT "fk_test_run_results_org_work_item"
  FOREIGN KEY ("org_id", "linked_work_item_id")
  REFERENCES "build"."tickets" ("org_id", "id")
  ON DELETE SET NULL ("linked_work_item_id") NOT VALID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_test_run_results_org_work_item"
  ON "build"."test_run_results" ("org_id", "linked_work_item_id");
