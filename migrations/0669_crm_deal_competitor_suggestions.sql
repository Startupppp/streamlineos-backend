-- Custom SQL migration file, put your code below! --

-- Competitors the system noticed, waiting for a person to say yes.
--
-- CRM-P2-12. `crm_deal_competitors` stays what it has always been: rows people
-- typed, read by the deal card, the win/loss report and the forecast. This table
-- holds the step before that — a name that appeared in an activity, the line it
-- appeared in, and no claim at all about the deal.
--
-- A second table rather than a `source` column on the first, because "who are we
-- competing with" must never return a guess. A status column on the existing
-- table would make every current reader depend on remembering a WHERE, and one
-- forgotten filter puts a machine's guess into a board review. Two tables make
-- forgetting impossible instead of discouraged.
--
-- The check constraint below is the part of this ticket that is structural
-- rather than conventional. The service also refuses to apply a suggestion
-- without a `HumanConfirmation` it cannot manufacture, and the scan path has no
-- `status` argument to pass -- but a service is a thing a future author edits,
-- and this is not. An accepted row that names nobody cannot be written by any
-- code path, present or future, correct or careless: Postgres rejects it.
--
-- `decided_by_user_id` carries no foreign key to `users`, matching
-- `crm_report_schedules.run_as_user_id`. A key here would fight the check rather
-- than help it -- ON DELETE SET NULL would null a decided row and violate it,
-- aborting the user delete, and RESTRICT would block deleting anyone who ever
-- reviewed a suggestion. What makes the column truthful is that there is nothing
-- unattended to put in it: migration 0663 established that this database has no
-- `users` row for the system and that the sentinel id 'system' had never once
-- resolved.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_deal_competitor_suggestions" (
  "competitor_suggestion_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "deal_id" integer NOT NULL,
  -- Copied from the tenant's own vocabulary -- the curated `crm_options` of type
  -- 'competitor' plus the keys people already captured on deals -- and never
  -- extracted from the text. Accepting a suggestion therefore cannot introduce a
  -- spelling nobody chose, and the worst available failure is a real competitor
  -- proposed on the wrong deal, which the quote beside it makes visible.
  "competitor_key" text NOT NULL,
  "source_kind" text NOT NULL,
  -- Provenance, not identity, and deliberately not a foreign key -- the same
  -- call `crm_call_analyses.activity_id` makes. Deleting a timeline entry must
  -- not silently delete the record of a decision somebody took because of it.
  "source_activity_id" text NOT NULL,
  -- The line that named them, verbatim. A proposal with no evidence is an
  -- assertion, and an assertion is the thing a reviewer cannot check.
  "evidence_quote" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "decided_by_user_id" text,
  "decided_at" timestamp,
  "decision_note" text,
  -- Which competitor row an acceptance produced or adopted, so provenance is one
  -- join rather than a string match.
  "applied_competitor_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "chk_crm_deal_competitor_suggestions_status"
    CHECK ("status" IN ('pending', 'accepted', 'dismissed')),
  CONSTRAINT "chk_crm_deal_competitor_suggestions_source_kind"
    CHECK ("source_kind" IN ('activity')),
  -- The refusal to auto-apply, in the one place no service can talk round.
  --
  -- Read as three rows in a truth table. A pending row is a question and has
  -- nothing decided about it. A dismissed row names who said no and when, and
  -- produced nothing. An accepted row names who said yes, when, AND which
  -- competitor row it became -- so "accepted" can never be a status somebody set
  -- without the write that gives it meaning actually having happened.
  CONSTRAINT "chk_crm_deal_competitor_suggestions_decided_by_a_person"
    CHECK (
      ("status" = 'pending'
        AND "decided_by_user_id" IS NULL
        AND "decided_at" IS NULL
        AND "applied_competitor_id" IS NULL)
      OR ("status" = 'dismissed'
        AND "decided_by_user_id" IS NOT NULL
        AND "decided_at" IS NOT NULL
        AND "applied_competitor_id" IS NULL)
      OR ("status" = 'accepted'
        AND "decided_by_user_id" IS NOT NULL
        AND "decided_at" IS NOT NULL
        AND "applied_competitor_id" IS NOT NULL)
    )
);

--> statement-breakpoint
-- NOT VALID then VALIDATE throughout, because ADD CONSTRAINT ... FOREIGN KEY
-- takes ACCESS EXCLUSIVE on BOTH tables while it installs its triggers.
ALTER TABLE "crm_deal_competitor_suggestions"
  ADD CONSTRAINT "fk_crm_deal_competitor_suggestions_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_deal_competitor_suggestions"
  VALIDATE CONSTRAINT "fk_crm_deal_competitor_suggestions_org";

--> statement-breakpoint
-- The composite tenant edge to the deal, leading with org_id, so a suggestion
-- cannot point at another tenant's deal even if the application forgot to say so.
ALTER TABLE "crm_deal_competitor_suggestions"
  ADD CONSTRAINT "fk_crm_deal_competitor_suggestions_deal"
  FOREIGN KEY ("organization_id", "deal_id")
  REFERENCES "deals" ("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_deal_competitor_suggestions"
  VALIDATE CONSTRAINT "fk_crm_deal_competitor_suggestions_deal";

--> statement-breakpoint
-- CASCADE and not SET NULL, deliberately. The check above requires an accepted
-- row to carry its pointer, so SET NULL would violate it and abort the parent
-- delete -- the trap 0662 was written for. It is also the right reading:
-- removing the competitor from the deal is a person taking the decision back,
-- which returns the name to the pool for a later scan to raise again.
--
-- `applied_competitor_id` is nullable and the FK is MATCH SIMPLE, so a pending
-- or dismissed row satisfies it without pointing at anything.
ALTER TABLE "crm_deal_competitor_suggestions"
  ADD CONSTRAINT "fk_crm_deal_competitor_suggestions_competitor"
  FOREIGN KEY ("organization_id", "applied_competitor_id")
  REFERENCES "crm_deal_competitors" ("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_deal_competitor_suggestions"
  VALIDATE CONSTRAINT "fk_crm_deal_competitor_suggestions_competitor";

--> statement-breakpoint
-- One proposal per name per deal, ever. This is what makes a re-scan safe to run
-- as often as somebody likes: the insert is ON CONFLICT DO NOTHING, so a name
-- already proposed is not proposed twice and -- the part that matters -- a name
-- somebody has already dismissed is never raised again. A dismissal that expired
-- at the next scan would teach people to dismiss the queue without reading it,
-- which is the one habit that would make this feature dangerous.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_crm_deal_competitor_suggestions_deal_key"
  ON "crm_deal_competitor_suggestions" ("organization_id", "deal_id", "competitor_key");

--> statement-breakpoint
-- The card's read: this deal's open proposals.
CREATE INDEX IF NOT EXISTS "idx_crm_deal_competitor_suggestions_deal_status"
  ON "crm_deal_competitor_suggestions" ("organization_id", "deal_id", "status");

--> statement-breakpoint
-- The composite tenant key a future child FK would lead with, and what makes
-- this table addressable by (tenant, id) rather than by id alone.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_deal_competitor_suggestions_org_id"
  ON "crm_deal_competitor_suggestions" ("organization_id", "competitor_suggestion_id");

--> statement-breakpoint
-- Tenant data, and a missing policy here would be silent: grants arrive through
-- ALTER DEFAULT PRIVILEGES, so an unpoliced table is readable org-wide by the
-- app role. `crm_deal_competitors` next door is already policed the same way.
ALTER TABLE "crm_deal_competitor_suggestions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_deal_competitor_suggestions";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_deal_competitor_suggestions"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_deal_competitor_suggestions" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_deal_competitor_suggestions" TO streamline_app;

--> statement-breakpoint
COMMENT ON CONSTRAINT "chk_crm_deal_competitor_suggestions_decided_by_a_person"
  ON "crm_deal_competitor_suggestions" IS
  'CRM-P2-12: a suggestion may only leave ''pending'' when it names the person who decided and when, and an accepted one must point at the competitor row it produced. This is the structural refusal to auto-apply -- do not relax it to let an unattended path record a decision.';

--> statement-breakpoint
ANALYZE "crm_deal_competitor_suggestions";
