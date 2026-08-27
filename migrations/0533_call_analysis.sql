-- Custom SQL migration file, put your code below! --

-- One reading of one call, and the two permissions that decide who sees it.
--
-- `crm_call_analyses` holds the analysis produced by the scheduled pass in
-- `modules/call-analysis/analyse`. One row per call, keyed on the activity, and
-- never written by anything a request can reach: the read module has no path to
-- the analyser, which is what stops opening a call costing a model call. See
-- `read-cannot-analyse.spec.ts`.
--
-- `source_digest` is the reason the table exists in this shape rather than as a
-- view. It is a SHA-256 of exactly the transcript text that was read, so an
-- unchanged transcript never reaches a model a second time; `analyser_version`
-- is the other half of that key, so a corrected analyser can still reach calls
-- that were read under the old one.
--
-- Three columns are here for legal reasons rather than product ones.
-- `jurisdiction` and `jurisdiction_basis` record where the call took place and
-- how firmly that was established, and `consent_regime` records what that place
-- required. There is deliberately NO column anywhere below that a tenant could
-- set to relax any of it -- the jurisdiction table is a frozen constant in
-- `modules/call-analysis/jurisdiction.ts`, and the two CHECK constraints here
-- make the unlawful row unrepresentable rather than merely unwritten. A
-- two-party-consent jurisdiction is a legal constraint, not a setting somebody
-- can switch off, and this is where that stops being a sentence in a ticket.
--
-- Authored by hand; see 0205 for why db:generate cannot run in this repository.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_call_analyses" (
  "crm_call_analysis_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "activity_id" text NOT NULL,
  "party_id" text,
  -- No foreign key to "users", for the reason `activities.actor_user_id` states:
  -- `scripts/purge-user.mjs` deletes every row whose column references it, so
  -- offboarding one rep would erase the coaching record of every call they made
  -- rather than detaching it from them.
  "rep_user_id" text,
  -- When the call happened, not when it was read. The rep's trend is drawn on
  -- this, so a backlog analysed in one pass does not draw six weeks as a line.
  "occurred_at" timestamp NOT NULL,
  "analysed_at" timestamp DEFAULT now() NOT NULL,
  "source_digest" text NOT NULL,
  "analyser_version" integer NOT NULL,
  "source_chars" integer NOT NULL,
  -- 'labelled' or 'unknown'. The two ratios below are NULL when it is 'unknown',
  -- because a talk ratio computed without knowing which side is which is a
  -- number with a plausible shape that somebody would be coached against.
  "diarisation" text NOT NULL,
  "talk_ratio_bps" integer,
  "question_share_bps" integer,
  "objections" jsonb NOT NULL,
  -- Matched against the organisation's own `crm_deal_competitors` keys, never
  -- named by a model: a competitor nobody in the organisation has heard of is
  -- worse than no answer, because nothing downstream can tell it from a real one.
  "competitor_keys" jsonb NOT NULL,
  "next_step_committed" boolean NOT NULL,
  "next_step_quote" text,
  "jurisdiction" text NOT NULL,
  "jurisdiction_basis" text NOT NULL,
  "consent_regime" text NOT NULL,
  "consent_status" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "crm_call_analyses" DROP CONSTRAINT IF EXISTS "chk_crm_call_analyses_diarisation";
--> statement-breakpoint
ALTER TABLE "crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_diarisation"
  CHECK ("diarisation" IN ('labelled', 'unknown'));

--> statement-breakpoint
-- A ratio outside its own scale is arithmetic that went wrong somewhere, and it
-- renders as a talk ratio of 340%.
ALTER TABLE "crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_ratios"
  CHECK (
    ("talk_ratio_bps" IS NULL OR ("talk_ratio_bps" >= 0 AND "talk_ratio_bps" <= 10000))
    AND ("question_share_bps" IS NULL OR ("question_share_bps" >= 0 AND "question_share_bps" <= 10000))
  );

--> statement-breakpoint
-- The two ratios stand or fall together with the diarisation that produced them.
-- Without this an undiarised call could still carry a talk ratio, which is the
-- one bad row that looks entirely normal on a screen.
ALTER TABLE "crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_undiarised_has_no_ratios"
  CHECK (
    "diarisation" <> 'unknown'
    OR ("talk_ratio_bps" IS NULL AND "question_share_bps" IS NULL)
  );

--> statement-breakpoint
ALTER TABLE "crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_jurisdiction_basis"
  CHECK ("jurisdiction_basis" IN ('counterparty-number', 'organisation-country', 'undetermined'));

--> statement-breakpoint
ALTER TABLE "crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_consent_regime"
  CHECK ("consent_regime" IN ('all-party', 'one-party'));

--> statement-breakpoint
ALTER TABLE "crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_consent_status"
  CHECK ("consent_status" IN ('OPTED_IN', 'OPTED_OUT', 'UNKNOWN'));

--> statement-breakpoint
-- The constraint that makes this enforcement rather than configuration.
--
-- A stored analysis of a call in an all-party-consent jurisdiction must carry an
-- explicit OPTED_IN, and no analysis of any call may carry an OPTED_OUT. Not a
-- rule the application remembers -- a rule the database refuses. Every route by
-- which the constraint could be circumvented in application code (a new writer,
-- a data fix, a well-meaning backfill, a support script) has to get past this,
-- and none of them can. It is also the reason consent withdrawal *deleting*
-- rows is checkable: an OPTED_OUT row cannot exist, so a row that survives a
-- withdrawal would have to be a row whose consent column was never updated,
-- which is a different and much more visible bug.
ALTER TABLE "crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_consent_honoured"
  CHECK (
    "consent_status" <> 'OPTED_OUT'
    AND ("consent_regime" <> 'all-party' OR "consent_status" = 'OPTED_IN')
  );

--> statement-breakpoint
ALTER TABLE "crm_call_analyses" ADD CONSTRAINT "fk_crm_call_analyses_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_call_analyses" VALIDATE CONSTRAINT "fk_crm_call_analyses_org";

--> statement-breakpoint
-- Composite on the tenant, against `uniq_activities_org_id` from 0215, so an
-- analysis can never point at another organisation's call even if the
-- application forgets to say which organisation it is in. CASCADE because an
-- analysis of a call that no longer exists is a reading of nothing.
ALTER TABLE "crm_call_analyses" ADD CONSTRAINT "fk_crm_call_analyses_activity"
  FOREIGN KEY ("organization_id", "activity_id")
  REFERENCES "activities"("organization_id", "activity_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_call_analyses" VALIDATE CONSTRAINT "fk_crm_call_analyses_activity";

--> statement-breakpoint
-- One analysis per call. The pass upserts on this, which is what makes a
-- re-analysis after a prompt change a replacement rather than a second row.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_call_analyses_activity"
  ON "crm_call_analyses" ("organization_id", "activity_id");

--> statement-breakpoint
-- The rep's own trend, which is the read this table exists for.
CREATE INDEX IF NOT EXISTS "idx_crm_call_analyses_rep_occurred"
  ON "crm_call_analyses" ("organization_id", "rep_user_id", "occurred_at");

--> statement-breakpoint
-- The read a withdrawal of consent makes. Withdrawal has to reach backwards
-- through everything already stored for that party, and without this it is a
-- scan of the organisation's whole analysis history per withdrawal.
CREATE INDEX IF NOT EXISTS "idx_crm_call_analyses_party"
  ON "crm_call_analyses" ("organization_id", "party_id");

--> statement-breakpoint
-- The manager aggregate, which is a window over the whole organisation.
CREATE INDEX IF NOT EXISTS "idx_crm_call_analyses_org_occurred"
  ON "crm_call_analyses" ("organization_id", "occurred_at");

--> statement-breakpoint
-- The candidate scan the pass opens with: this organisation's calls that have a
-- transcript, newest first. Partial on both predicates, so the index holds only
-- the rows the pass can actually analyse -- on a tenant whose timeline is mostly
-- email, that is a small fraction of `activities`.
CREATE INDEX IF NOT EXISTS "idx_activities_org_call_transcribed"
  ON "activities" ("organization_id", "occurred_at")
  WHERE "kind" = 'call' AND "deleted_at" IS NULL AND "body" IS NOT NULL;

--> statement-breakpoint
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
-- Two permissions, not one.
--
-- Seeing your own calls is something every seller should have from the day they
-- are hired; seeing the team pooled is a manager's. A single key would mean
-- granting a rep the team surface in order to give them their own.
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('crm:call-analysis:view-own', 'crm:call-analysis', 'view-own',
   'See the analysis of your own calls and your own trend over time', 'crm'),
  ('crm:call-analysis:view-team', 'crm:call-analysis', 'view-team',
   'See the team''s pooled call coaching aggregates and prompts, never an individual call or person', 'crm')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
-- Granted to the slugs `seedSystemRolesForOrg` actually mints, and this is the
-- whole reason the grant is written this way.
--
-- Seven migrations in this series granted `WHERE slug = 'CRM_ADMIN'`, copied
-- from `ROLE_TEMPLATES` -- which is a template an administrator may choose to
-- create a role from, not what an organisation is seeded with. All seven matched
-- zero rows and granted eighteen permissions to nobody, silently, because
-- `ON CONFLICT DO NOTHING` over an empty result set is a clean migration.
-- `rbac/__tests__/backfill-slugs-exist.spec.ts` now refuses any slug the seeder
-- cannot produce; this migration is written to pass it.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'crm:call-analysis:view-own', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN', 'CRM_MODULE_MEMBER')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'crm:call-analysis:view-own')
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- The team surface reaches the owner and the administrator only. A member who
-- was handed it would be reading a pooled view of colleagues, which is the
-- shape ticket 02 exists to prevent.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'crm:call-analysis:view-team', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'crm:call-analysis:view-team')
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Without this every session keeps its cached permission set until it expires,
-- so a backfill that worked would still read as a 403 for hours.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" LIKE 'CRM_MODULE_%'
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();

--> statement-breakpoint
ANALYZE "crm_call_analyses";
--> statement-breakpoint
ANALYZE "activities";
