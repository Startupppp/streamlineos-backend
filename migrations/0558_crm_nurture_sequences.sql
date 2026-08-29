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

-- Fail fast rather than queue behind whatever holds the table.
SET lock_timeout = '5s';
--> statement-breakpoint
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
-- Partial, because the table soft-deletes: every read that uses this index
-- excludes deleted rows, so carrying them in it is dead weight the planner has
-- to filter back out.
CREATE INDEX IF NOT EXISTS "idx_crm_nurture_sequences_org"
  ON "crm_nurture_sequences" ("organization_id", "status", "created_at")
  WHERE "deleted_at" IS NULL;
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
  "deal_id"               INTEGER,
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

-- ── Relational integrity ────────────────────────────────────────────────────
--
-- Composite on the tenant as well as the key, which is the shape the rest of
-- this schema uses: a child that referenced only its parent's id could name a
-- parent in another organisation and the foreign key would be satisfied. RLS
-- does not close that — a policy filters what a query returns, it does not
-- constrain what a write may point at.
--
-- Each one needs a unique on the parent's (organisation, id) pair to point at.
ALTER TABLE "crm_nurture_sequences"
  ADD CONSTRAINT "uniq_crm_nurture_sequences_org_id"
  UNIQUE ("organization_id", "nurture_sequence_id");
--> statement-breakpoint
ALTER TABLE "crm_nurture_enrollments"
  ADD CONSTRAINT "uniq_crm_nurture_enrollments_org_id"
  UNIQUE ("organization_id", "nurture_enrollment_id");
--> statement-breakpoint

ALTER TABLE "crm_nurture_sequence_steps"
  ADD CONSTRAINT "fk_crm_nurture_sequence_steps_sequence"
  FOREIGN KEY ("organization_id", "nurture_sequence_id")
  REFERENCES "crm_nurture_sequences" ("organization_id", "nurture_sequence_id")
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "crm_nurture_enrollments"
  ADD CONSTRAINT "fk_crm_nurture_enrollments_sequence"
  FOREIGN KEY ("organization_id", "nurture_sequence_id")
  REFERENCES "crm_nurture_sequences" ("organization_id", "nurture_sequence_id")
  ON DELETE CASCADE;
--> statement-breakpoint
-- The enrolment is about the party, so it goes when the party does.
ALTER TABLE "crm_nurture_enrollments"
  ADD CONSTRAINT "fk_crm_nurture_enrollments_party"
  FOREIGN KEY ("organization_id", "party_id")
  REFERENCES "business_parties" ("organization_id", "party_id")
  ON DELETE CASCADE;
--> statement-breakpoint
-- `SET NULL`, not cascade: an enrolment outlives the deal it was about. The
-- sequence is a conversation with a person, and losing the deal should not lose
-- the record that we were talking to them.
ALTER TABLE "crm_nurture_enrollments"
  ADD CONSTRAINT "fk_crm_nurture_enrollments_deal"
  FOREIGN KEY ("organization_id", "deal_id")
  REFERENCES "deals" ("org_id", "id")
  ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "crm_nurture_step_attempts"
  ADD CONSTRAINT "fk_crm_nurture_step_attempts_enrollment"
  FOREIGN KEY ("organization_id", "nurture_enrollment_id")
  REFERENCES "crm_nurture_enrollments" ("organization_id", "nurture_enrollment_id")
  ON DELETE CASCADE;
--> statement-breakpoint

-- Every foreign key gets an index on the referencing side: without one, deleting
-- a parent sequential-scans each child to find what to cascade.
CREATE INDEX IF NOT EXISTS "idx_crm_nurture_enrollments_deal"
  ON "crm_nurture_enrollments" ("organization_id", "deal_id")
  WHERE "deal_id" IS NOT NULL;
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
