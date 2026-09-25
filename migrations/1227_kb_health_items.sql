-- 1227 — Knowledge base: kb_health_items, the Content Health persistence layer.
--
-- S15 (REQUIREMENT-LEDGER, "Content Health"): every content-health signal is
-- recomputed from kb_pages on every request
-- (src/modules/kb/content-health/kb-content-health.service.ts:48-79). A computed
-- signal has no identity, so it cannot carry an assignee, a due date, a
-- dismissal reason, a resolution timestamp, or a before/after trend — which is
-- why the controller exposes only two GET routes and no workflow at all. This
-- table is the row the four remaining S15 boxes have nowhere to hang.
--
-- Columns are exactly the ledger box's list: tenant, page, kind, versioned
-- evidence JSON, impact, state, assignee, due, detected/resolved/dismissed,
-- rule version.
--
-- Why the unique index is partial. The box asks for a unique *active*
-- (org_id, page_id, kind, rule_version). A plain unique index would also
-- collide with resolved and dismissed history, so re-detecting a signal a user
-- had dismissed last quarter would raise 23505 instead of opening a new item.
-- The WHERE state = 'open' arm is what makes "active" mean active — see
-- MEMORY.md "soft-delete-vs-non-partial-unique-index" for the same mistake
-- made the other way round.
--
-- Why evidence is jsonb and rule_version is in the key. Evidence is
-- signal-shaped, not table-shaped (a broken-link item cites link rows; a
-- duplicate-candidate item cites a sibling page id), so BE-42's "normalize
-- lifecycle entities" does not apply — evidence is an immutable snapshot of
-- why a rule fired, never a lifecycle entity of its own. Pinning rule_version
-- into the uniqueness key is what lets a detector be corrected: a v2 rule
-- opens a new item beside the v1 one rather than silently mutating the
-- evidence a human already read.
--
-- Scope note, deliberate. page_id is NOT NULL, so this table is page-shaped,
-- exactly as the box specifies. There is an open question — recorded in
-- LEDGER-PATCH-L6 under S14 "assign/dismiss for gaps" — about whether
-- query-shaped work items (knowledge gaps, unanswered searches) should share
-- this table. This migration does not pre-decide it. If that decision lands on
-- "one shared table", page_id must be made nullable and this unique index
-- reformed; that is a follow-up migration, not a reason to withhold the
-- page-shaped schema the box fully specifies today.
--
-- HANDOFF: authored and NOT applied by lane L6, and NOT journalled — the
-- orchestrator owns migrations/meta/_journal.json and the apply. Nothing reads
-- or writes this table yet: no Drizzle table was added to src/db/schema/kb/,
-- deliberately, so that no call site can compile against a column production
-- does not have. See MEMORY.md
-- "pending-migration-plus-live-call-site-is-a-deploy-landmine". The same
-- precedent lane L5 set for 1217 and lane L6 set for 1218.
--
-- Rollback: migrations/rollback/1227_kb_health_items.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_pages') IS NULL THEN
    RAISE EXCEPTION '1227 precondition: public.kb_pages is absent — this is not a Knowledge database';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_kb_pages_org_id') THEN
    RAISE EXCEPTION '1227 precondition: uniq_kb_pages_org_id is absent — the tenant-safe composite foreign key cannot be declared';
  END IF;
  IF to_regclass('public.organization_members') IS NULL THEN
    RAISE EXCEPTION '1227 precondition: public.organization_members is absent — the assignee foreign key cannot be declared';
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."kb_health_items" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" text NOT NULL,
  "page_id" integer NOT NULL,
  "kind" text NOT NULL,
  "rule_version" integer NOT NULL DEFAULT 1,
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "impact" integer NOT NULL DEFAULT 0,
  "state" text NOT NULL DEFAULT 'open',
  "assignee_membership_id" integer,
  "due_at" timestamp with time zone,
  "detected_at" timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone,
  "dismissed_at" timestamp with time zone,
  "dismissed_reason" text,
  "dismissal_expires_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_kb_health_items_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_kb_health_items_kind" CHECK (
    "kind" IN (
      'unowned', 'stale', 'unverified', 'empty', 'overdue_review',
      'broken_link', 'overexposed', 'duplicate_candidate', 'contradictory_claim'
    )
  ),
  CONSTRAINT "chk_kb_health_items_state" CHECK (
    "state" IN ('open', 'resolved', 'dismissed')
  ),
  CONSTRAINT "chk_kb_health_items_impact_range" CHECK ("impact" BETWEEN 0 AND 100),
  CONSTRAINT "chk_kb_health_items_dismissed_reason" CHECK (
    "state" <> 'dismissed' OR "dismissed_reason" IS NOT NULL
  ),
  CONSTRAINT "chk_kb_health_items_resolved_at" CHECK (
    "state" <> 'resolved' OR "resolved_at" IS NOT NULL
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_health_items_active"
  ON "public"."kb_health_items" ("org_id", "page_id", "kind", "rule_version")
  WHERE "state" = 'open';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_health_items_org_state_impact"
  ON "public"."kb_health_items" ("org_id", "state", "impact" DESC, "id" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_health_items_org_kind_state"
  ON "public"."kb_health_items" ("org_id", "kind", "state");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_health_items_org_page"
  ON "public"."kb_health_items" ("org_id", "page_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_health_items_org_assignee"
  ON "public"."kb_health_items" ("org_id", "assignee_membership_id")
  WHERE "assignee_membership_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_health_items_org_due"
  ON "public"."kb_health_items" ("org_id", "due_at")
  WHERE "due_at" IS NOT NULL AND "state" = 'open';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_health_items_org_dismissal_expiry"
  ON "public"."kb_health_items" ("org_id", "dismissal_expires_at")
  WHERE "dismissal_expires_at" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "public"."kb_health_items" DROP CONSTRAINT IF EXISTS "kb_health_items_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."kb_health_items" ADD CONSTRAINT "kb_health_items_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_health_items" VALIDATE CONSTRAINT "kb_health_items_org_id_organizations_id_fk";
--> statement-breakpoint

ALTER TABLE "public"."kb_health_items" DROP CONSTRAINT IF EXISTS "fk_kb_health_items_org_page";
--> statement-breakpoint
ALTER TABLE "public"."kb_health_items" ADD CONSTRAINT "fk_kb_health_items_org_page"
  FOREIGN KEY ("org_id", "page_id") REFERENCES "public"."kb_pages" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_health_items" VALIDATE CONSTRAINT "fk_kb_health_items_org_page";
--> statement-breakpoint

ALTER TABLE "public"."kb_health_items" DROP CONSTRAINT IF EXISTS "fk_kb_health_items_org_assignee";
--> statement-breakpoint
ALTER TABLE "public"."kb_health_items" ADD CONSTRAINT "fk_kb_health_items_org_assignee"
  FOREIGN KEY ("org_id", "assignee_membership_id") REFERENCES "public"."organization_members" ("org_id", "id")
  ON DELETE SET NULL ("assignee_membership_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."kb_health_items" VALIDATE CONSTRAINT "fk_kb_health_items_org_assignee";
--> statement-breakpoint

ALTER TABLE "public"."kb_health_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "public"."kb_health_items";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."kb_health_items"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."kb_health_items" TO streamline_app;
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_health_items') IS NULL THEN
    RAISE EXCEPTION '1227 postcondition: kb_health_items was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'uniq_kb_health_items_active') THEN
    RAISE EXCEPTION '1227 postcondition: uniq_kb_health_items_active was not created — the active-uniqueness the box requires is absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'kb_health_items' AND policyname = 'tenant_isolation') THEN
    RAISE EXCEPTION '1227 postcondition: tenant_isolation policy is absent — kb_health_items would read cross-tenant';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'kb_health_items'
      AND grantee = 'streamline_app' AND privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION '1227 postcondition: streamline_app holds no SELECT on kb_health_items — every read would fail 42501';
  END IF;
END $$;
--> statement-breakpoint
