-- Custom SQL migration file, put your code below! --

-- Per-call analysis, stored once per transcript.
--
-- Phase 5 ticket 01. A completed call is an `activities` row with
-- `kind = 'call'` and the transcript in `body` -- that is what the ingress seam
-- writes and there is no separate call table, so this hangs off the timeline
-- rather than duplicating it.
--
-- The key is the SHA-256 of the transcript, not the activity. Re-analysing the
-- same transcript has to be free AND has to return the identical answer, and
-- the second half is the one a cache keyed on the call cannot give: a language
-- model asked the same question twice does not agree with itself, so a customer
-- record would show a different set of objections depending on when it was last
-- opened. The same transcript arriving twice -- a carrier replay, a re-import,
-- one recording filed against both a party and a deal -- is one row and one paid
-- model call.
--
-- Tenant-scoped even though a hash is tenant-neutral. The row carries verbatim
-- quotes out of a customer conversation, so a cache shared across organisations
-- would trade a saving nobody will ever collect for a cross-tenant disclosure.
--
-- Authored by hand against `db/schema/crm/call-analysis.ts`, column for column:
-- `drizzle-kit generate` is unusable in this repository (see 0205).

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_call_analyses" (
  "call_analysis_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,

  -- Lowercase hex SHA-256 of the normalised transcript. See `transcript-hash.ts`
  -- for what "normalised" removes and, more importantly, what it refuses to.
  "transcript_hash" text NOT NULL,
  -- Bumped in code when the prompt or the contract changes. Without it, editing
  -- the prompt would apply to calls nobody had analysed yet and to no others,
  -- with nothing on the row to say which software judged which call.
  "analyzer_version" integer NOT NULL,

  -- Provenance, not identity: the call this was FIRST produced for. Not a
  -- foreign key to `activities` on purpose -- deleting a timeline entry must not
  -- silently delete the reason a deal was called at risk.
  "activity_id" text NOT NULL,

  -- Basis points of 10000, never a float. NULL means the transcript carried no
  -- speaker attribution, or the model could not say which side was ours. NULL is
  -- "unknown" and is rendered as such; it is never fifty percent.
  "talk_ratio_bps" integer,
  -- The counts, not the rate. A stored rate is a division nobody can check;
  -- these two can be re-derived, re-banded, and summed across calls.
  "rep_turn_count" integer,
  "rep_question_count" integer,

  "objections" jsonb NOT NULL,
  "competitor_mentions" jsonb NOT NULL,

  -- A boolean beside the text rather than "the text is non-empty": a call with
  -- no next step is exactly what a manager filters for, and filtering on
  -- emptiness makes that query depend on whether the model wrote "none" or "".
  "next_step_committed" boolean NOT NULL,
  "next_step" text,

  "model" text,
  "prompt_key" text NOT NULL,
  "prompt_version" integer NOT NULL,
  -- How much text was actually judged, after the cap, so a thin answer on a long
  -- call can be explained rather than guessed at.
  "transcript_chars" integer NOT NULL,

  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- A truncated digest is not a cache key, it is a collision waiting to show one
-- customer's objections on another customer's timeline. Pinned in the database
-- so a later caller that decided storage mattered more cannot write one.
ALTER TABLE "crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_hash"
  CHECK ("transcript_hash" ~ '^[0-9a-f]{64}$');

--> statement-breakpoint
ALTER TABLE "crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_talk_ratio"
  CHECK ("talk_ratio_bps" IS NULL OR ("talk_ratio_bps" >= 0 AND "talk_ratio_bps" <= 10000));

--> statement-breakpoint
-- The three metrics come from one parse of one transcript, so they are all
-- known or none of them is. A row with a talk ratio and no turn count would make
-- the question rate silently undefined for a call that reports a confident
-- ratio, which reads as "this rep asked no questions".
ALTER TABLE "crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_metrics_arc"
  CHECK (num_nonnulls("talk_ratio_bps", "rep_turn_count", "rep_question_count") IN (0, 3));

--> statement-breakpoint
ALTER TABLE "crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_counts"
  CHECK (
    ("rep_turn_count" IS NULL AND "rep_question_count" IS NULL) OR
    ("rep_turn_count" >= 0 AND "rep_question_count" >= 0)
  );

--> statement-breakpoint
-- A commitment nobody could name is not a commitment. Without this arc the
-- next-step rate counts every polite goodbye, which is the metric reporting
-- every call as a success.
ALTER TABLE "crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_next_step"
  CHECK (
    ("next_step_committed" = true AND "next_step" IS NOT NULL) OR
    ("next_step_committed" = false AND "next_step" IS NULL)
  );

--> statement-breakpoint
ALTER TABLE "crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_transcript_chars"
  CHECK ("transcript_chars" > 0);

--> statement-breakpoint
-- The quoted material is an array of objects; a bare string or a number here
-- would pass the column type and then break every reader.
ALTER TABLE "crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_json_arrays"
  CHECK (jsonb_typeof("objections") = 'array' AND jsonb_typeof("competitor_mentions") = 'array');

--> statement-breakpoint
-- NOT VALID then VALIDATE, so adding the edge does not hold ACCESS EXCLUSIVE on
-- organizations while it runs.
ALTER TABLE "crm_call_analyses" ADD CONSTRAINT "fk_crm_call_analyses_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_call_analyses" VALIDATE CONSTRAINT "fk_crm_call_analyses_org";

--> statement-breakpoint
-- The index that makes the cache a cache. Two concurrent analyses of one
-- transcript would otherwise both insert, and the next read would get whichever
-- row the planner reached first: two paid model calls and a coin flip over which
-- answer a customer record shows. The service inserts ON CONFLICT DO NOTHING and
-- re-reads, so the loser of the race agrees with the winner.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_call_analyses_hash"
  ON "crm_call_analyses" ("organization_id", "transcript_hash", "analyzer_version");

--> statement-breakpoint
-- The read the call surface makes: this activity, by analyser version.
CREATE INDEX IF NOT EXISTS "idx_crm_call_analyses_activity"
  ON "crm_call_analyses" ("organization_id", "activity_id", "analyzer_version");

--> statement-breakpoint
-- Without a policy the table is readable organisation-wide: grants arrive
-- through ALTER DEFAULT PRIVILEGES, so a missing policy is silent -- and what
-- leaks here is what a named customer said, word for word.
ALTER TABLE "crm_call_analyses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_call_analyses";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_call_analyses"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_call_analyses" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_call_analyses" TO streamline_app;

--> statement-breakpoint
ANALYZE "crm_call_analyses";
