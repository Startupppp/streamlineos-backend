-- Custom SQL migration file, put your code below! --

-- One queue, many producers -- and the ledger of what a person decided about it.
--
-- Phase 1's duplicate detector already files pairs in
-- `party_duplicate_candidates` and `crm_data_quality` counts eight other
-- problems into a dashboard. Neither is work: no owner, no age, no record of
-- what was decided. These two tables are what turns a finding into somebody's
-- job.
--
-- Three things here are load-bearing and each is a bug this programme has
-- already shipped once.
--
-- `first_detected_at` is written once and never updated. The nightly sweep
-- upserts on the partial unique below and refreshes evidence, severity and
-- `last_seen_at` -- never the age and never the assignee. An age that resets
-- every night is not an age, and a sweep that un-assigns somebody's work makes
-- the queue unusable inside a day.
--
-- `data_quality_resolutions` is one row per DECISION, not per finding. Four
-- hundred parties with the same malformed number is one row here and four
-- hundred pointers to it, so it is reviewed once, counted once and undone once.
--
-- No column here is a foreign key to `users`. `scripts/purge-user.mjs` deletes
-- every row whose column references `users` regardless of the delete rule, so an
-- assignee edge would destroy the queue's history the day somebody is
-- offboarded. See 0223; `autonomous_decisions.reversed_by_user_id` and
-- `deal_stage_transitions.actor_user_id` do the same.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_quality_resolutions" (
  "resolution_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,

  "action" text NOT NULL,
  "selection_kind" text NOT NULL,
  "group_key" text,

  -- Deliberately the same vocabulary as `autonomous_decisions.reversibility`,
  -- so the review feed and this queue read alike rather than teaching a person
  -- two dialects for one idea.
  "reversibility" text NOT NULL,
  "hold_until" timestamp,

  "reason" text,

  -- Three counts, not one. The gap between attempted and resolved is the
  -- interesting part: an item somebody else took a second earlier, or one whose
  -- remediation failed. Reporting only the successes makes a half-applied bulk
  -- decision look complete.
  "attempted_count" integer NOT NULL,
  "resolved_count" integer DEFAULT 0 NOT NULL,
  "failed_count" integer DEFAULT 0 NOT NULL,
  "failures" jsonb,

  -- No FK to users: see 0223. A decision has to outlive its decider.
  "decided_by_user_id" text NOT NULL,
  "decided_at" timestamp DEFAULT now() NOT NULL,

  "reversed_at" timestamp,
  "reversed_by_user_id" text,
  "reversed_reason" text,
  "reversed_count" integer
);

--> statement-breakpoint
ALTER TABLE "data_quality_resolutions" ADD CONSTRAINT "chk_data_quality_resolutions_action"
  CHECK ("action" IN ('apply', 'dismiss'));

--> statement-breakpoint
ALTER TABLE "data_quality_resolutions" ADD CONSTRAINT "chk_data_quality_resolutions_selection"
  CHECK (
    ("selection_kind" = 'ids'   AND "group_key" IS NULL) OR
    ("selection_kind" = 'group' AND "group_key" IS NOT NULL)
  );

--> statement-breakpoint
ALTER TABLE "data_quality_resolutions" ADD CONSTRAINT "chk_data_quality_resolutions_reversibility"
  CHECK ("reversibility" IN ('instant', 'hold', 'irreversible'));

--> statement-breakpoint
-- A deadline belongs only to the class that has one. An `instant` decision needs
-- no deadline, and an `irreversible` one carrying a deadline would be promising
-- a window that does not exist.
ALTER TABLE "data_quality_resolutions" ADD CONSTRAINT "chk_data_quality_resolutions_hold"
  CHECK (("reversibility" = 'hold') OR ("hold_until" IS NULL));

--> statement-breakpoint
ALTER TABLE "data_quality_resolutions" ADD CONSTRAINT "chk_data_quality_resolutions_reversal"
  CHECK (
    ("reversed_at" IS NULL     AND "reversed_by_user_id" IS NULL) OR
    ("reversed_at" IS NOT NULL AND "reversed_by_user_id" IS NOT NULL)
  );

--> statement-breakpoint
ALTER TABLE "data_quality_resolutions" ADD CONSTRAINT "chk_data_quality_resolutions_counts"
  CHECK (
    "attempted_count" >= 0 AND "resolved_count" >= 0 AND "failed_count" >= 0
    AND "resolved_count" <= "attempted_count"
  );

--> statement-breakpoint
ALTER TABLE "data_quality_resolutions" ADD CONSTRAINT "fk_data_quality_resolutions_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "data_quality_resolutions" VALIDATE CONSTRAINT "fk_data_quality_resolutions_org";

--> statement-breakpoint
-- The composite tenant key the findings' foreign key points at. Postgres will
-- not accept a composite FK without a unique constraint covering exactly its
-- referenced columns, and this table's primary key is the id alone.
ALTER TABLE "data_quality_resolutions" ADD CONSTRAINT "uniq_data_quality_resolutions_org_id"
  UNIQUE ("organization_id", "resolution_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_data_quality_resolutions_feed"
  ON "data_quality_resolutions" ("organization_id", "decided_at", "resolution_id");

--> statement-breakpoint
-- What is still undoable, for the surface that offers the undo.
CREATE INDEX IF NOT EXISTS "idx_data_quality_resolutions_open"
  ON "data_quality_resolutions" ("organization_id", "decided_at")
  WHERE "reversed_at" IS NULL;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_quality_findings" (
  "finding_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,

  "producer" text NOT NULL,
  "finding_kind" text NOT NULL,
  -- What the finding is about, in a form the producer can recompute. The dedupe
  -- key: a second sweep updates the finding instead of filing a copy.
  "subject_key" text NOT NULL,
  -- The SHAPE of the problem, which is the axis a bulk decision slices on.
  -- Producers put the severity band inside it, so one group is one severity and
  -- therefore one decision.
  "group_key" text NOT NULL,

  "severity" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,

  -- Explicit columns rather than an entity_type/entity_id pair, which is banned
  -- for new tables: no referential integrity and no composite tenant key. Every
  -- producer wired today is party-shaped; a finding about something else gets
  -- its own column and a widened CHECK, the way `autonomy_holds` treats
  -- `quote_id`.
  "party_id" text NOT NULL,
  "related_party_id" text,

  "evidence" jsonb,
  "score" double precision,

  "proposed_action" text NOT NULL,
  "proposed_patch" jsonb,
  "reversibility" text NOT NULL,

  -- No FK to users: see 0223, and the header above.
  "assigned_to_user_id" text,
  "assigned_by_user_id" text,
  "assigned_at" timestamp,

  -- Set once, at first detection. Re-detection moves `last_seen_at` instead.
  "first_detected_at" timestamp DEFAULT now() NOT NULL,
  "last_seen_at" timestamp DEFAULT now() NOT NULL,

  "resolved_at" timestamp,
  "resolved_by_user_id" text,
  "resolution_id" text,
  -- What an undo needs, captured when the action succeeded. Reconstructing it
  -- later cannot tell a field a merge filled from one a person edited since.
  "undo_token" jsonb,

  "attempt_count" integer DEFAULT 0 NOT NULL,
  "last_error" text
);

--> statement-breakpoint
ALTER TABLE "data_quality_findings" ADD CONSTRAINT "chk_data_quality_findings_producer"
  CHECK ("producer" IN ('duplicate', 'contradiction', 'reachability', 'staleness', 'import-uncertainty'));

--> statement-breakpoint
ALTER TABLE "data_quality_findings" ADD CONSTRAINT "chk_data_quality_findings_severity"
  CHECK ("severity" IN ('high', 'medium', 'low'));

--> statement-breakpoint
ALTER TABLE "data_quality_findings" ADD CONSTRAINT "chk_data_quality_findings_status"
  CHECK ("status" IN ('open', 'resolved', 'dismissed'));

--> statement-breakpoint
-- Constrained rather than free text because every value needs an executor and a
-- reversibility class, and a value with neither is a promise the queue cannot
-- keep. Adding one is a migration, which is correct: it needs code anyway.
ALTER TABLE "data_quality_findings" ADD CONSTRAINT "chk_data_quality_findings_action"
  CHECK ("proposed_action" IN ('merge-parties', 'none'));

--> statement-breakpoint
ALTER TABLE "data_quality_findings" ADD CONSTRAINT "chk_data_quality_findings_reversibility"
  CHECK ("reversibility" IN ('instant', 'hold', 'irreversible'));

--> statement-breakpoint
-- A pair needs two records, and a finding about one record must not carry a
-- second: `related_party_id` set for a single-record producer would put a merge
-- button under something that is not a pair.
ALTER TABLE "data_quality_findings" ADD CONSTRAINT "chk_data_quality_findings_pair"
  CHECK ("related_party_id" IS NULL OR "related_party_id" <> "party_id");

--> statement-breakpoint
-- Open means unresolved, in every column that says so. `resolution_id` is
-- deliberately outside the open branch: a reversal reopens a finding and leaves
-- the pointer, so "what did that decision cover" stays answerable afterwards.
ALTER TABLE "data_quality_findings" ADD CONSTRAINT "chk_data_quality_findings_terminal"
  CHECK (
    ("status" = 'open' AND "resolved_at" IS NULL AND "resolved_by_user_id" IS NULL) OR
    ("status" IN ('resolved', 'dismissed')
       AND "resolved_at" IS NOT NULL
       AND "resolution_id" IS NOT NULL)
  );

--> statement-breakpoint
-- Assigned to nobody, by Dave, last Tuesday is a state that reads as a bug every
-- time somebody sees it.
ALTER TABLE "data_quality_findings" ADD CONSTRAINT "chk_data_quality_findings_assignment"
  CHECK (
    ("assigned_to_user_id" IS NULL     AND "assigned_at" IS NULL AND "assigned_by_user_id" IS NULL) OR
    ("assigned_to_user_id" IS NOT NULL AND "assigned_at" IS NOT NULL)
  );

--> statement-breakpoint
ALTER TABLE "data_quality_findings" ADD CONSTRAINT "fk_data_quality_findings_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "data_quality_findings" VALIDATE CONSTRAINT "fk_data_quality_findings_org";

--> statement-breakpoint
/*
 * The composite FKs below need a unique constraint on exactly
 * ("organization_id", "party_id"). `0307` creates it as an index and `0324`
 * promotes it to a constraint -- both journalled before this migration, so this
 * block is belt and braces for a database built by a different route. Promotes
 * the existing index rather than duplicating it, following `0228`.
 */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_business_parties_org_party') THEN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uniq_business_parties_org_party' AND relkind = 'i') THEN
      ALTER TABLE "business_parties" ADD CONSTRAINT "uniq_business_parties_org_party"
        UNIQUE USING INDEX "uniq_business_parties_org_party";
    ELSE
      ALTER TABLE "business_parties" ADD CONSTRAINT "uniq_business_parties_org_party"
        UNIQUE ("organization_id", "party_id");
    END IF;
  END IF;
END $$;

--> statement-breakpoint
ALTER TABLE "data_quality_findings" ADD CONSTRAINT "fk_data_quality_findings_party"
  FOREIGN KEY ("organization_id", "party_id")
  REFERENCES "business_parties"("organization_id", "party_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "data_quality_findings" VALIDATE CONSTRAINT "fk_data_quality_findings_party";

--> statement-breakpoint
ALTER TABLE "data_quality_findings" ADD CONSTRAINT "fk_data_quality_findings_related_party"
  FOREIGN KEY ("organization_id", "related_party_id")
  REFERENCES "business_parties"("organization_id", "party_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "data_quality_findings" VALIDATE CONSTRAINT "fk_data_quality_findings_related_party";

--> statement-breakpoint
/*
 * CASCADE, not SET NULL. A composite `ON DELETE SET NULL` nulls BOTH referencing
 * columns, and `organization_id` is NOT NULL -- so deleting a resolution would
 * fail outright rather than orphan the finding. That is the trap 0240 recorded
 * on `business_parties.acquisition_campaign_id`.
 *
 * Nothing deletes a resolution; the only path here is the organisation cascade,
 * which removes the findings anyway.
 */
ALTER TABLE "data_quality_findings" ADD CONSTRAINT "fk_data_quality_findings_resolution"
  FOREIGN KEY ("organization_id", "resolution_id")
  REFERENCES "data_quality_resolutions"("organization_id", "resolution_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "data_quality_findings" VALIDATE CONSTRAINT "fk_data_quality_findings_resolution";

--> statement-breakpoint
-- One open finding per problem, and the target `ON CONFLICT` infers. Partial on
-- `open` so a recurrence after a resolution files a NEW finding rather than
-- resurrecting a closed one, which would lose the record that somebody already
-- dealt with it once.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_data_quality_findings_open"
  ON "data_quality_findings" ("organization_id", "producer", "finding_kind", "subject_key")
  WHERE "status" = 'open';

--> statement-breakpoint
-- The queue itself: oldest first, because age is the point. The identifier is
-- IN the key rather than beside it -- a sweep files hundreds of findings in one
-- instant, and a keyset on the timestamp alone would skip and repeat rows on
-- every page after the first.
CREATE INDEX IF NOT EXISTS "idx_data_quality_findings_queue"
  ON "data_quality_findings" ("organization_id", "status", "first_detected_at", "finding_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_data_quality_findings_assignee"
  ON "data_quality_findings" ("organization_id", "assigned_to_user_id", "first_detected_at")
  WHERE "status" = 'open';

--> statement-breakpoint
-- The grouped view, and the predicate a group-shaped bulk decision claims on.
CREATE INDEX IF NOT EXISTS "idx_data_quality_findings_group"
  ON "data_quality_findings" ("organization_id", "group_key", "status", "finding_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_data_quality_findings_party"
  ON "data_quality_findings" ("organization_id", "party_id", "status");

--> statement-breakpoint
-- What one decision covered: the undo's own read.
CREATE INDEX IF NOT EXISTS "idx_data_quality_findings_resolution"
  ON "data_quality_findings" ("organization_id", "resolution_id");

--> statement-breakpoint
-- "Is the dataset getting better or worse" is opened-in-window against
-- closed-in-window, and the closed half has no other indexed path to it.
CREATE INDEX IF NOT EXISTS "idx_data_quality_findings_closed"
  ON "data_quality_findings" ("organization_id", "resolved_at")
  WHERE "resolved_at" IS NOT NULL;

--> statement-breakpoint
ALTER TABLE "data_quality_findings" ADD CONSTRAINT "uniq_data_quality_findings_org_id"
  UNIQUE ("organization_id", "finding_id");

--> statement-breakpoint
ALTER TABLE "data_quality_resolutions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "data_quality_resolutions";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "data_quality_resolutions"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "data_quality_resolutions" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "data_quality_resolutions" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "data_quality_findings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "data_quality_findings";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "data_quality_findings"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "data_quality_findings" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "data_quality_findings" TO streamline_app;

--> statement-breakpoint
ANALYZE "data_quality_resolutions";
--> statement-breakpoint
ANALYZE "data_quality_findings";
