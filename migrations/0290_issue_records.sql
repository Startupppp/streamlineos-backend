-- Custom SQL migration file, put your code below! --

-- Ticket 18 / `D27`. Internal issues, internal tasks and customer complaints
-- become three RECORD TYPES on the Phase 1 renderer, not three modules.
--
-- The instinct is three tables. It is wrong for the same reason `subject_types`
-- is right: the renderer takes its layout as data, so a record type is a field
-- declaration plus a row keyed to match it. These three share severity, an
-- owner, a clock and an accountability ledger, and differ only in who raises
-- them and whether a Party is required. Three tables would be three bespoke
-- modules wearing one name, and a fourth record type would be a fourth
-- migration.
--
-- Five things here are load-bearing, and four of them are bugs this programme
-- has already shipped once.
--
-- No column is a foreign key to `users`. `scripts/purge-user.mjs` deletes every
-- row whose column references `users` regardless of the delete rule, so an owner
-- edge would erase a customer's complaint history the day the person who owned
-- it is offboarded -- destroying the record of the failure, not just its owner.
-- See 0223, which removed exactly this edge from two other tables.
--
-- `party_id` and `deal_id` are COMPOSITE tenant keys, so a complaint in one
-- organisation cannot reference another organisation's party or deal and still
-- satisfy referential integrity. `ON DELETE CASCADE` on both: the tempting
-- `SET NULL` over a composite key nulls `organization_id` too, which is NOT NULL
-- (0240), and CASCADE costs nothing here because both parents are soft-deleted
-- and nothing in `src/` hard-deletes either. The one path that does fire is an
-- organisation being torn down, where removing its complaints is correct.
--
-- `deal_id` is `integer`, matching `deals.id`. `activities.deal_id` is `text`
-- against the same column, which is exactly why that table has no foreign key.
--
-- `issue_stage_transitions` is `deal_stage_transitions` column for column, and
-- that is deliberate rather than a copy that drifted. Ticket 08 built that
-- ledger because a stage change was a `deal_activities` row whose `user_id`
-- referenced `users` and could not be null -- so an action the SYSTEM took was
-- not representable, and an autonomous change had nowhere to say it was
-- autonomous. Escalation has the identical problem and gets the identical
-- remedy: a discriminated actor with a CHECK enforcing it. The ONE intentional
-- difference is that the `system` arm here also requires `actor_label`. The deal
-- ledger permits a system row that names nothing, and an unattributable
-- autonomous action is the failure the discriminated actor exists to prevent.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_records" (
  "issue_record_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,

  -- What raised it, which is the only thing the three genuinely disagree about.
  "record_type" text NOT NULL,

  "reference" text,
  "title" text NOT NULL,
  "details" text,

  -- Literally `FINDING_SEVERITIES` from the data-quality queue, not a parallel
  -- set that means almost the same thing. `SEVERITY_WEIGHTS` already prices
  -- these three, so a weighted view across both queues is arithmetic rather than
  -- a mapping table -- and a person moving between them is not learning two
  -- dialects for one idea.
  "severity" text NOT NULL,

  -- Where it is. `escalated` is a stage like any other: escalation is not a flag
  -- or a parallel accountability model, it is a transition into the ledger below.
  -- `resolved` and `dismissed` are `FINDING_STATUSES` verbatim and keep that
  -- table's distinction -- one says the thing was real and has been dealt with,
  -- the other says it was not real.
  "stage" text DEFAULT 'open' NOT NULL,

  -- No FK to users: see 0223. Whose job this is has to outlive their employment.
  "owner_user_id" text,

  -- The clock, as four instants rather than one duration. A duration cannot say
  -- when the clock started, and one deadline cannot say whether the first
  -- response was late but the fix on time.
  "opened_at" timestamp DEFAULT now() NOT NULL,
  "due_at" timestamp,
  "acknowledged_at" timestamp,
  "closed_at" timestamp,

  "party_id" text,
  "deal_id" integer,

  -- No FK to users: see 0223.
  "created_by_user_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "issue_records" ADD CONSTRAINT "chk_issue_records_type"
  CHECK ("record_type" IN ('issue', 'task', 'complaint'));

--> statement-breakpoint
ALTER TABLE "issue_records" ADD CONSTRAINT "chk_issue_records_severity"
  CHECK ("severity" IN ('high', 'medium', 'low'));

--> statement-breakpoint
ALTER TABLE "issue_records" ADD CONSTRAINT "chk_issue_records_stage"
  CHECK ("stage" IN ('open', 'acknowledged', 'escalated', 'resolved', 'dismissed'));

--> statement-breakpoint
-- Criterion 2, in the database rather than only at the boundary. A complaint
-- from nobody cannot be traced to the relationship it damaged, and the whole
-- point of anchoring one to a Party is that the commercial consequence of a
-- service failure shows up where the commercial decision is made. The DTO
-- refuses it too, with a message; this refuses it for every writer that never
-- passes through the DTO.
ALTER TABLE "issue_records" ADD CONSTRAINT "chk_issue_records_complaint_party"
  CHECK ("record_type" <> 'complaint' OR "party_id" IS NOT NULL);

--> statement-breakpoint
-- A deal anchor with no party is a commercial link to nobody. The deal already
-- names its own party; a record claiming one and not the other is a record whose
-- two anchors can disagree.
ALTER TABLE "issue_records" ADD CONSTRAINT "chk_issue_records_deal_needs_party"
  CHECK ("deal_id" IS NULL OR "party_id" IS NOT NULL);

--> statement-breakpoint
-- The terminal stages carry a closing time, and only they. Reopening clears it,
-- so a record that came back is not still holding the date it was first closed.
ALTER TABLE "issue_records" ADD CONSTRAINT "chk_issue_records_closed"
  CHECK (
    ("stage" IN ('resolved', 'dismissed') AND "closed_at" IS NOT NULL) OR
    ("stage" NOT IN ('resolved', 'dismissed') AND "closed_at" IS NULL)
  );

--> statement-breakpoint
ALTER TABLE "issue_records" ADD CONSTRAINT "fk_issue_records_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "issue_records" VALIDATE CONSTRAINT "fk_issue_records_org";

--> statement-breakpoint
/*
 * The two composite foreign keys below need unique constraints on exactly
 * ("organization_id", "party_id") and ("org_id", "id"). Both are present in the
 * live database, but a database built purely by running migrations in order
 * would abort here with `42830: there is no unique constraint matching given
 * keys` if either were only a Drizzle declaration or only an index. Promotes an
 * existing unique index rather than duplicating it, following 0214 and 0250.
 */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_business_parties_org_party') THEN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uniq_business_parties_org_party' AND relkind = 'i') THEN
      ALTER TABLE "business_parties"
        ADD CONSTRAINT "uniq_business_parties_org_party" UNIQUE USING INDEX "uniq_business_parties_org_party";
    ELSE
      ALTER TABLE "business_parties"
        ADD CONSTRAINT "uniq_business_parties_org_party" UNIQUE ("organization_id", "party_id");
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_deals_org_id') THEN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uniq_deals_org_id' AND relkind = 'i') THEN
      ALTER TABLE "deals" ADD CONSTRAINT "uniq_deals_org_id" UNIQUE USING INDEX "uniq_deals_org_id";
    ELSE
      ALTER TABLE "deals" ADD CONSTRAINT "uniq_deals_org_id" UNIQUE ("org_id", "id");
    END IF;
  END IF;
END $$;

--> statement-breakpoint
ALTER TABLE "issue_records" ADD CONSTRAINT "fk_issue_records_party"
  FOREIGN KEY ("organization_id", "party_id")
  REFERENCES "business_parties"("organization_id", "party_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "issue_records" VALIDATE CONSTRAINT "fk_issue_records_party";

--> statement-breakpoint
ALTER TABLE "issue_records" ADD CONSTRAINT "fk_issue_records_deal"
  FOREIGN KEY ("organization_id", "deal_id")
  REFERENCES "deals"("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "issue_records" VALIDATE CONSTRAINT "fk_issue_records_deal";

--> statement-breakpoint
-- The list read: one record type, oldest first. The identifier is in the key
-- because a sweep can file many records in the same instant, and a cursor on the
-- timestamp alone would skip some of them and repeat others on every page after
-- the first. Leading organization_id because the RLS predicate is not leakproof
-- and the planner needs it in the index.
CREATE INDEX IF NOT EXISTS "idx_issue_records_type_feed"
  ON "issue_records" ("organization_id", "record_type", "opened_at", "issue_record_id");

--> statement-breakpoint
-- "What is still mine", which is the only question an owner asks daily.
CREATE INDEX IF NOT EXISTS "idx_issue_records_owner"
  ON "issue_records" ("organization_id", "owner_user_id", "stage")
  WHERE "closed_at" IS NULL;

--> statement-breakpoint
-- A party's complaints, read from the party surface.
CREATE INDEX IF NOT EXISTS "idx_issue_records_party"
  ON "issue_records" ("organization_id", "party_id")
  WHERE "party_id" IS NOT NULL;

--> statement-breakpoint
-- A deal's complaints -- and the composite foreign key's own delete-time lookup,
-- which searches on the same pair, so one index serves both.
CREATE INDEX IF NOT EXISTS "idx_issue_records_org_deal"
  ON "issue_records" ("organization_id", "deal_id")
  WHERE "deal_id" IS NOT NULL;

--> statement-breakpoint
-- Per record type, so a tenant's task numbering and their complaint numbering
-- are allowed to collide: they are different sequences.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_issue_records_org_type_reference"
  ON "issue_records" ("organization_id", "record_type", "reference")
  WHERE "reference" IS NOT NULL;

--> statement-breakpoint
-- The composite tenant key the transition ledger's foreign key points at.
ALTER TABLE "issue_records" ADD CONSTRAINT "uniq_issue_records_org_id"
  UNIQUE ("organization_id", "issue_record_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_stage_transitions" (
  "issue_stage_transition_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "issue_record_id" text NOT NULL,

  -- Null on the first transition, where the record had no prior stage.
  "from_stage" text,
  "to_stage" text NOT NULL,

  "actor_kind" text NOT NULL,
  -- No FK to users: see 0223, and `deal_stage_transitions.actor_user_id`, which
  -- does the same for the same reason. A purged actor leaves an id that resolves
  -- to nobody and renders as an unknown actor -- a strictly better failure than
  -- an audit entry that was deleted along with the person.
  "actor_user_id" text,
  "actor_label" text,

  "reason" text,
  "occurred_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- A human transition without a person, or a system one wearing someone's name,
-- would both make the history lie. The database refuses each rather than leaving
-- it to every caller to remember.
--
-- The `system` arm additionally requires `actor_label`, which is this ledger's
-- one intentional divergence from `chk_deal_stage_transition_actor`. That
-- constraint permits a system row naming nothing, and "something escalated this"
-- is not accountability -- it is the same gap in a smaller form.
ALTER TABLE "issue_stage_transitions" ADD CONSTRAINT "chk_issue_stage_transition_actor"
  CHECK (
    ("actor_kind" = 'human'  AND "actor_user_id" IS NOT NULL) OR
    ("actor_kind" = 'system' AND "actor_user_id" IS NULL AND "actor_label" IS NOT NULL)
  );

--> statement-breakpoint
ALTER TABLE "issue_stage_transitions" ADD CONSTRAINT "chk_issue_stage_transition_stages"
  CHECK (
    ("from_stage" IS NULL OR "from_stage" IN ('open', 'acknowledged', 'escalated', 'resolved', 'dismissed'))
    AND "to_stage" IN ('open', 'acknowledged', 'escalated', 'resolved', 'dismissed')
    AND ("from_stage" IS NULL OR "from_stage" <> "to_stage")
  );

--> statement-breakpoint
ALTER TABLE "issue_stage_transitions" ADD CONSTRAINT "fk_issue_stage_transitions_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "issue_stage_transitions" VALIDATE CONSTRAINT "fk_issue_stage_transitions_org";

--> statement-breakpoint
-- Composite tenant key, so a transition cannot reference another organisation's
-- record and still satisfy referential integrity.
ALTER TABLE "issue_stage_transitions" ADD CONSTRAINT "fk_issue_stage_transitions_record"
  FOREIGN KEY ("organization_id", "issue_record_id")
  REFERENCES "issue_records"("organization_id", "issue_record_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "issue_stage_transitions" VALIDATE CONSTRAINT "fk_issue_stage_transitions_record";

--> statement-breakpoint
-- One record's history, newest first.
CREATE INDEX IF NOT EXISTS "idx_issue_stage_transitions_record"
  ON "issue_stage_transitions" ("organization_id", "issue_record_id", "occurred_at");

--> statement-breakpoint
-- And the review feed's read: everything the system did, newest first. The same
-- pair `deal_stage_transitions` carries, for the same two reads.
CREATE INDEX IF NOT EXISTS "idx_issue_stage_transitions_actor"
  ON "issue_stage_transitions" ("organization_id", "actor_kind", "occurred_at");

--> statement-breakpoint
-- The RLS matrix, extended to both tables. Without a policy each is readable
-- organisation-wide, because grants arrive through ALTER DEFAULT PRIVILEGES and
-- a missing policy is silent.
ALTER TABLE "issue_records" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_records";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "issue_records"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "issue_records" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "issue_records" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "issue_stage_transitions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "issue_stage_transitions";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "issue_stage_transitions"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "issue_stage_transitions" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "issue_stage_transitions" TO streamline_app;

--> statement-breakpoint
-- Catalog rows first, for the reason recorded in 0212: `PermissionCatalogSync`
-- runs at boot, AFTER `db:migrate`, so the EXISTS guard below is otherwise false
-- and every grant is silently skipped.
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('crm:issues:view', 'crm:issues', 'view',
   'View internal issues, internal tasks and customer complaints', 'crm'),
  ('crm:issues:manage', 'crm:issues', 'manage',
   'Raise, edit and move internal issues, internal tasks and customer complaints', 'crm'),
  ('crm:issues:escalate', 'crm:issues', 'escalate',
   'Escalate an issue, task or complaint above its owner', 'crm')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
-- Targets `CRM_MODULE_OWNER` and `CRM_MODULE_ADMIN`, which is what
-- `seedSystemRolesForOrg` actually mints. It does NOT target `CRM_ADMIN` -- that
-- is a `ROLE_TEMPLATES` slug an administrator may manually create a role from,
-- and the seven migrations that named it granted eighteen permissions to nobody
-- at all, silently, because `ON CONFLICT DO NOTHING` over an empty result set is
-- a clean migration. See 0226 and 0232, and
-- `rbac/__tests__/backfill-slugs-exist.spec.ts`, which fails the build on a
-- repeat.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (VALUES
  ('crm:issues:view'),
  ('crm:issues:manage'),
  ('crm:issues:escalate')
) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" IN ('CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."permission_key")
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Member gets `:view` and nothing else, matching
-- `buildModuleMemberPermissionKeys`, which grants keys ending `:view` or
-- `:read`. That agreement is the invariant: a backfilled organisation and a
-- newly seeded one must resolve to the same capability, or a tenant's
-- permissions depend on when they signed up.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'crm:issues:view', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" = 'CRM_MODULE_MEMBER'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'crm:issues:view')
ON CONFLICT DO NOTHING;

--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" LIKE 'CRM_MODULE_%'
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();

--> statement-breakpoint
ANALYZE "issue_records";
--> statement-breakpoint
ANALYZE "issue_stage_transitions";
