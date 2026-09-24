-- 1190 — Recruitment: a reusable job template library
--
-- Every posting today is authored from an empty form, so the same engineering
-- role is rewritten from memory each time it is opened and drifts a little on
-- every pass. A template is the authored half of a posting — the prose, the
-- employment terms and the screening questions — saved once and stamped onto
-- new openings.
--
-- NOT named `hr_*`. HR's `hr_*` table count is frozen, and this is a
-- recruitment-domain table alongside `job_postings`, `hiring_flows` and
-- `scorecard_templates`, none of which carry the prefix either.
--
-- Deliberately NOT related to `offer_templates`. That table renders a document
-- for one named candidate at the end of the pipeline; this one seeds a posting
-- at the start of it. They share a word and nothing else, and merging them
-- would put an offer's merge fields in a recruiter's job-description picker.
--
-- The lifecycle columns a posting owns are absent on purpose: no `status`, no
-- `openings`, no `application_deadline`, no `posted_by`. A template that could
-- be OPEN would eventually be applied to, and a deadline copied forward is
-- always the wrong date. Only what a human typed is worth reusing.
SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "job_templates" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL,
  -- The librarian's label ("Senior Backend Engineer — India"), not the job
  -- title. Separate columns because one template serves several openings whose
  -- titles differ, and a recruiter browsing the library searches on this.
  "name" text NOT NULL,
  -- The authored payload, mirroring `job_postings` column for column so
  -- applying a template is a copy rather than a translation.
  "title" text,
  "description" text,
  "requirements" text,
  "benefits" text,
  "type" text NOT NULL DEFAULT 'FULL_TIME',
  "experience" text,
  "screening_questions" jsonb,
  "job_level_id" integer,
  "created_by_membership_id" integer,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  -- Soft delete. A template is cited by the postings it produced and by the
  -- recruiters who remember its name; a hard delete would make both dangle.
  "deleted_at" timestamp,
  -- The composite key every tenant-scoped FK in this schema targets, so a
  -- future child row can point at (org_id, id) and never at a bare id.
  CONSTRAINT "uniq_job_templates_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_job_templates_name_present" CHECK (length(btrim("name")) > 0)
);
--> statement-breakpoint

-- Per-org, not global. A bare UNIQUE on `name` would let the first tenant to
-- save "Software Engineer" block that name for every other tenant on the
-- platform, and the second tenant would read the 409 as a bug in their own data.
--
-- Partial on `deleted_at IS NULL`: deleting a template and creating a new one
-- under the same name is the ordinary way to replace it, and a full unique
-- index would refuse that forever because the deleted row is still there.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_job_templates_org_name"
  ON "job_templates" ("org_id", "name")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

-- The library list: one org's live templates, newest first, keyset-paginated
-- on (created_at, id). Tenant column first because every read of this table is
-- tenant-scoped and the RLS qual supplies `org_id` on every one of them.
CREATE INDEX IF NOT EXISTS "idx_job_templates_org_created"
  ON "job_templates" ("org_id", "created_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

-- The picker on the job-create form filters by employment type before the
-- recruiter has typed anything.
CREATE INDEX IF NOT EXISTS "idx_job_templates_org_type"
  ON "job_templates" ("org_id", "type")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

-- The two FK-supporting indexes are NOT partial, unlike the read-path indexes
-- above. Their job is the referential action on the parent side: deleting a
-- job level or a membership has to find every child row that points at it,
-- including the soft-deleted ones. A partial index hides exactly those and the
-- delete falls back to a sequential scan of the whole table.
CREATE INDEX IF NOT EXISTS "idx_job_templates_org_job_level"
  ON "job_templates" ("org_id", "job_level_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_job_templates_org_created_by_membership"
  ON "job_templates" ("org_id", "created_by_membership_id");
--> statement-breakpoint

ALTER TABLE "job_templates" DROP CONSTRAINT IF EXISTS "job_templates_org_id_organizations_id_fk";
--> statement-breakpoint
-- NOT VALID then VALIDATE throughout: a single-step ADD CONSTRAINT … FOREIGN KEY
-- takes ACCESS EXCLUSIVE on both sides while it installs the triggers, and
-- `organizations`, `organization_members` and `hr_job_levels` are read by every
-- request in the platform.
ALTER TABLE "job_templates" ADD CONSTRAINT "job_templates_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "job_templates" VALIDATE CONSTRAINT "job_templates_org_id_organizations_id_fk";
--> statement-breakpoint

ALTER TABLE "job_templates" DROP CONSTRAINT IF EXISTS "fk_job_templates_job_level_id_org";
--> statement-breakpoint
-- The column list on SET NULL is load-bearing. A bare ON DELETE SET NULL on a
-- composite key nulls `org_id` too, which violates its own NOT NULL and aborts
-- the parent delete instead of clearing the reference.
ALTER TABLE "job_templates" ADD CONSTRAINT "fk_job_templates_job_level_id_org"
  FOREIGN KEY ("org_id", "job_level_id") REFERENCES "public"."hr_job_levels" ("org_id", "id")
  ON DELETE SET NULL ("job_level_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "job_templates" VALIDATE CONSTRAINT "fk_job_templates_job_level_id_org";
--> statement-breakpoint

ALTER TABLE "job_templates" DROP CONSTRAINT IF EXISTS "fk_job_templates_created_by_actor";
--> statement-breakpoint
ALTER TABLE "job_templates" ADD CONSTRAINT "fk_job_templates_created_by_actor"
  FOREIGN KEY ("org_id", "created_by_membership_id") REFERENCES "public"."organization_members" ("org_id", "id")
  ON DELETE SET NULL ("created_by_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "job_templates" VALIDATE CONSTRAINT "fk_job_templates_created_by_actor";
--> statement-breakpoint

ALTER TABLE "job_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "job_templates";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "job_templates"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "job_templates" TO streamline_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "job_templates_id_seq" TO streamline_app;
