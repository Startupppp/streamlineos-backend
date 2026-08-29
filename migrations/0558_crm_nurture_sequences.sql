-- Nurture sequences (P5-mk), which existed only as a Drizzle declaration.
--
-- `src/db/schema/crm/nurture-sequences.ts` declares four tables and no migration
-- ever created any of them, so every database built from this journal is missing
-- the whole feature. The services, the workflow and the reply-exit path were all
-- written against tables that are not there.
--
-- This is the declaration turned into DDL, unchanged in shape: same columns,
-- same defaults, same partial indexes. The two constraints that carry the
-- feature's argument are reproduced exactly —
--
--   `uniq_crm_nurture_enrollments_live_party` is per tenant and NOT per
--   sequence, because two sequences nurturing one customer at once is the
--   "talking over them" failure the ticket exists to prevent. The frequency cap
--   would blunt that at send time; this refuses it at enrolment, where a person
--   can be told why.
--
--   `uniq_crm_nurture_step_attempts_step` is what makes a second attempt at one
--   step a 23505 rather than a second message to the same customer. The
--   workflow's step memo already makes it at-most-once on the happy path, but a
--   memo lives in `workflow_steps` and a run whose steps were pruned would
--   re-attempt.
--
-- Every table carries `organization_id` including the children, which could have
-- reached it through their parent. They carry it because RLS is per table: a
-- policy on the parent protects nothing about a query that starts at the child.

-- ── The cadence ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "crm_nurture_sequences" (
  "nurture_sequence_id" TEXT PRIMARY KEY,
  "organization_id"     TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name"                TEXT NOT NULL,
  "description"         TEXT,
  "status"              TEXT NOT NULL DEFAULT 'draft',
  "created_by_user_id"  TEXT,
  "deleted_at"          TIMESTAMP,
  "created_at"          TIMESTAMP NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMP NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Partial on `deleted_at IS NULL` so a deleted name is reusable.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_nurture_sequences_name"
  ON "crm_nurture_sequences" ("organization_id", lower("name"))
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_nurture_sequences_org"
  ON "crm_nurture_sequences" ("organization_id", "status", "created_at");
--> statement-breakpoint

-- ── A step: a wait, and nothing else ────────────────────────────────────────
-- No subject, no body, no recipient. A step says only "consider writing to this
-- person again, this long after the last one"; the considering is
-- `OutboundService.composeAndHold`, which drafts, judges and holds.
CREATE TABLE IF NOT EXISTS "crm_nurture_sequence_steps" (
  "nurture_step_id"      TEXT PRIMARY KEY,
  "organization_id"      TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "nurture_sequence_id"  TEXT NOT NULL,
  "step_number"          INTEGER NOT NULL,
  "wait_hours"           INTEGER NOT NULL,
  "created_at"           TIMESTAMP NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_nurture_sequence_steps_number"
  ON "crm_nurture_sequence_steps" ("nurture_sequence_id", "step_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_nurture_sequence_steps_seq"
  ON "crm_nurture_sequence_steps" ("organization_id", "nurture_sequence_id", "step_number");
--> statement-breakpoint

-- ── An enrolment ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "crm_nurture_enrollments" (
  "nurture_enrollment_id" TEXT PRIMARY KEY,
  "organization_id"       TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "nurture_sequence_id"   TEXT NOT NULL,
  "party_id"              TEXT NOT NULL,
  "deal_id"               TEXT,
  "status"                TEXT NOT NULL DEFAULT 'active',
  "current_step"          INTEGER NOT NULL DEFAULT 0,
  "exit_reason"           TEXT,
  "exited_at"             TIMESTAMP,
  "workflow_run_id"       TEXT,
  "enrolled_at"           TIMESTAMP NOT NULL DEFAULT now(),
  "enrolled_by_user_id"   TEXT,
  "updated_at"            TIMESTAMP NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Per tenant, not per sequence. See the header.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_nurture_enrollments_live_party"
  ON "crm_nurture_enrollments" ("organization_id", "party_id")
  WHERE "status" = 'active';
--> statement-breakpoint
-- The exit-on-reply read, in the order it filters: org, party, status. It runs
-- on the inbound path for every delivered reply, not on a background sweep.
CREATE INDEX IF NOT EXISTS "idx_crm_nurture_enrollments_party"
  ON "crm_nurture_enrollments" ("organization_id", "party_id", "status")
  WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_nurture_enrollments_sequence"
  ON "crm_nurture_enrollments" ("organization_id", "nurture_sequence_id", "enrolled_at");
--> statement-breakpoint

-- ── What a step produced, including when it produced nothing ────────────────
-- A refusal is recorded as well as a send: a sequence that has been refusing
-- every step for a fortnight must not look like one patiently waiting.
CREATE TABLE IF NOT EXISTS "crm_nurture_step_attempts" (
  "nurture_step_attempt_id" TEXT PRIMARY KEY,
  "organization_id"         TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "nurture_enrollment_id"   TEXT NOT NULL,
  "step_number"             INTEGER NOT NULL,
  "outcome"                 TEXT NOT NULL,
  "reason"                  TEXT,
  "outbound_message_id"     TEXT,
  "autonomy_hold_id"        TEXT,
  "created_at"              TIMESTAMP NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_nurture_step_attempts_step"
  ON "crm_nurture_step_attempts" ("nurture_enrollment_id", "step_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_nurture_step_attempts_org"
  ON "crm_nurture_step_attempts" ("organization_id", "created_at");
--> statement-breakpoint

-- ── Tenant isolation ────────────────────────────────────────────────────────
ALTER TABLE "crm_nurture_sequences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_nurture_sequences";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_nurture_sequences"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_nurture_sequences" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_nurture_sequences" TO streamline_app;
--> statement-breakpoint

ALTER TABLE "crm_nurture_sequence_steps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_nurture_sequence_steps";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_nurture_sequence_steps"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_nurture_sequence_steps" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_nurture_sequence_steps" TO streamline_app;
--> statement-breakpoint

ALTER TABLE "crm_nurture_enrollments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_nurture_enrollments";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_nurture_enrollments"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_nurture_enrollments" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_nurture_enrollments" TO streamline_app;
--> statement-breakpoint

ALTER TABLE "crm_nurture_step_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_nurture_step_attempts";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_nurture_step_attempts"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_nurture_step_attempts" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_nurture_step_attempts" TO streamline_app;
