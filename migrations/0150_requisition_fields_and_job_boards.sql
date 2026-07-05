-- PRD 10 (External Job Board Posting) — TalentOS Milestone 3.
-- job_board_postings is a normalized replacement surface for the job_postings.external_posting_ids
-- jsonb column (a lifecycle-entity-in-jsonb anti-pattern) for manually-tracked board postings;
-- the existing jsonb column and publish() flow are left in place for now (used by the jobs list
-- "Post to boards" action) and will be migrated in a later pass.
--
-- (A department_id/level/linked_job_posting_id enrichment of job_requisitions was drafted
-- alongside this but held back pending explicit sign-off on altering the live requisitions
-- table — job_requisitions.create-job flow instead reuses the existing linked_job_id column.)

BEGIN;

CREATE TABLE "job_board_postings" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "job_posting_id" integer NOT NULL REFERENCES "job_postings"("id") ON DELETE CASCADE,
  "platform" text NOT NULL,
  "external_post_url" text,
  "status" text NOT NULL DEFAULT 'DRAFT',
  "posted_by" text REFERENCES "users"("id"),
  "posted_at" timestamp,
  "expiry_date" timestamp,
  "spend" decimal(12, 2),
  "applicant_count" integer NOT NULL DEFAULT 0,
  "qualified_count" integer NOT NULL DEFAULT 0,
  "hired_count" integer NOT NULL DEFAULT 0,
  "notes" text,
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX "idx_job_board_postings_job" ON "job_board_postings" ("job_posting_id");
CREATE INDEX "idx_job_board_postings_org" ON "job_board_postings" ("org_id");

COMMIT;
