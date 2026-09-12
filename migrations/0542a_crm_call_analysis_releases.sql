-- Custom SQL migration file, put your code below! --

-- The rep's decision to hand their own call analysis over early.
--
-- Phase 5 ticket 02. A rep can always read the analysis of a call they were on;
-- anybody else waits until the rep releases it or until the rep has had it for
-- CALL_ANALYSIS_PRIVATE_WINDOW_HOURS. This table is the first half of that --
-- the release -- and `call-analysis-visibility.ts` is the rule that reads it.
--
-- A separate table rather than a `released_at` column on `crm_call_analyses`,
-- because of how that table is keyed. An analysis row is keyed on the SHA-256 of
-- the transcript, so one row can be the analysis of several `activities` rows: a
-- carrier replay, a re-import, one recording filed against both a party and a
-- deal. Consent is not a property of a transcript. A column on the shared row
-- would let one rep releasing their copy publish a colleague's copy of the same
-- conversation, with nothing anywhere recording that it had happened.
--
-- `analyzer_version` sits in the unique key beside the activity, and that is the
-- reason the column is here at all. A release is consent to the judgement the
-- rep actually read. Bumping CALL_ANALYSIS_ANALYZER_VERSION produces a different
-- judgement of the same call -- different objections, possibly a different
-- verdict on whether a next step was committed -- and carrying old consent
-- forward would publish a paragraph about somebody they never saw. A new
-- analyser re-closes the window.
--
-- There is no withdrawal, here or in the service. Once a manager has read it,
-- un-sharing does not unread it, and an "unshare" control would promise a
-- retraction the system cannot perform.
--
-- Authored by hand against `db/schema/crm/call-analysis.ts`, column for column:
-- `drizzle-kit generate` is unusable in this repository (see 0205).

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_call_analysis_releases" (
  "call_analysis_release_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,

  -- The call, not the analysis row. See the header for why consent is per call.
  -- Not a foreign key to `activities`, for the same reason
  -- `crm_call_analyses.activity_id` is not one: a timeline delete must not be
  -- able to quietly revoke a decision a person made.
  "activity_id" text NOT NULL,

  -- The analyser whose output was released. A bump re-closes the window.
  "analyzer_version" integer NOT NULL,

  -- No foreign key to `users`, the house rule on every actor column in this
  -- schema (stated at length on `activities.actor_user_id`, and see 0223):
  -- `scripts/purge-user.mjs` deletes by reference without consulting the delete
  -- rule, so offboarding a rep would erase the record of every call they chose
  -- to share.
  "released_by_user_id" text NOT NULL,

  -- What the rep wanted said alongside it. Optional, and present because
  -- sharing early is an act of communication; a release with nowhere to put
  -- that is a switch, which is the surveillance reading of the same feature.
  "note" text,

  "released_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- A note is a sentence, not a thread. Without the bound this column becomes a
-- comment field by accretion, with no retention rule and no redaction pass over
-- text a rep may well paste a customer's words into.
ALTER TABLE "crm_call_analysis_releases" ADD CONSTRAINT "chk_crm_call_analysis_releases_note"
  CHECK ("note" IS NULL OR char_length("note") <= 500);

--> statement-breakpoint
ALTER TABLE "crm_call_analysis_releases" ADD CONSTRAINT "chk_crm_call_analysis_releases_version"
  CHECK ("analyzer_version" > 0);

--> statement-breakpoint
-- NOT VALID then VALIDATE, so adding the edge does not hold ACCESS EXCLUSIVE on
-- organizations while it runs.
ALTER TABLE "crm_call_analysis_releases" ADD CONSTRAINT "fk_crm_call_analysis_releases_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_call_analysis_releases" VALIDATE CONSTRAINT "fk_crm_call_analysis_releases_org";

--> statement-breakpoint
-- One release per call per analyser, and this is what makes releasing
-- idempotent. Without it, a rep tapping "share" twice writes two rows and the
-- visibility rule then has to pick a `released_at` from two -- a question with
-- no right answer that only exists because the table let it be asked. The
-- service inserts ON CONFLICT DO NOTHING and re-reads, so the first decision
-- stands and `released_at` never moves forward.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_call_analysis_releases"
  ON "crm_call_analysis_releases" ("organization_id", "activity_id", "analyzer_version");

--> statement-breakpoint
-- Without a policy the table is readable organisation-wide: grants arrive
-- through ALTER DEFAULT PRIVILEGES, so a missing policy is silent. What leaks
-- here is thinner than an analysis but not nothing -- who shared which call,
-- when, and whatever they wrote in the note.
ALTER TABLE "crm_call_analysis_releases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_call_analysis_releases";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_call_analysis_releases"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_call_analysis_releases" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_call_analysis_releases" TO streamline_app;

--> statement-breakpoint
ANALYZE "crm_call_analysis_releases";
