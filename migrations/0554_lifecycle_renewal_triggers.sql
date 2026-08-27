-- Custom SQL migration file, put your code below! --

-- Phase 5 ticket 09. Renewal and churn triggers, feeding the loops that exist.
--
-- One table, and it is deliberately small. It holds no message, no hold, no
-- guardrail evaluation and no send: a trigger records that a contract crossed a
-- threshold, points at the renewal OPPORTUNITY that was opened for it, and
-- records what `OutboundService.composeAndHold` answered each time it was
-- offered that opportunity. Everything downstream already exists —
-- `autonomous_decisions` is the ledger, `autonomy_holds` is the window a human
-- can cancel inside, `crm_outbound_messages` is the message — and the columns
-- below point at those rows rather than restating them.
--
-- The alternative shape, which this one exists to avoid, is a retention machine
-- with its own sender. That machine has to reimplement the eligibility
-- judgement, the kill switch, the hold window, the late guardrail snapshot, the
-- cold gate and the frequency caps, and the reimplementation is always the one
-- missing the working-hours check. A renewal is an opportunity; the outbound
-- loop already knows how to work an opportunity.
--
-- `term_started_on` rather than a fired-at date is what makes a sweep safe to
-- run on a schedule. A renewal ADVANCES `customer_lifecycles.started_on` (see
-- 0550), so the next term is a different value and opens its own conversation,
-- while tonight's sweep over the same term finds the row already there. Keying
-- on the lifecycle alone would open one conversation per customer forever;
-- keying on the day the sweep ran would open one per night.
--
-- The unique index deliberately does NOT carry `kind`. A term whose renewal-due
-- trigger has fired must not also fire a churn-risk one and put the same
-- customer in the pipeline twice for the same contract. The kind records WHY the
-- one conversation opened when it did.
--
-- `outcome` is `held` or `skipped` and never `sent`: whether a held message
-- actually leaves is decided at the far end of the hold window by
-- `send-guardrails.ts`, and a second record of that here could disagree with
-- `crm_outbound_messages`.
--
-- Authored by hand; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_lifecycle_triggers" (
  "customer_lifecycle_trigger_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "customer_lifecycle_id" text NOT NULL,

  -- Denormalised from the lifecycle, and worth the copy: this is the value
  -- actually handed to the outbound loop, so the hand-off must not depend on a
  -- join a merged party can move underneath it.
  "party_id" text NOT NULL,

  -- renewal-due (the calendar) or churn-risk (the evidence overruling it).
  "kind" text NOT NULL,

  -- The term this fired for. The idempotency key; see the header note.
  "term_started_on" date NOT NULL,
  -- The renewal date as it stood when this fired, so the log reads alone.
  "renewal_on" date NOT NULL,

  -- The day the conversation became DUE, not the day a sweep noticed. This is
  -- written onto the opportunity as its next-step date and read back by the
  -- outbound loop's `next-step-overdue` branch. Dating it to the sweep would
  -- make every trigger look freshly due however long it had been ignored.
  "due_on" date NOT NULL,

  -- The scores at the moment this fired. `health_score` is NULLABLE because
  -- `customer_health_assessments.score` is (0552): null means the model could
  -- not say, which is not zero and not fifty.
  "risk_score" integer NOT NULL,
  "health_score" integer,

  -- The renewal opportunity: an ordinary open deal, in the tenant's own
  -- pipeline, worked by the same people who work everything else. Nullable only
  -- between claiming the term and opening the deal -- a window of one statement,
  -- and in that order on purpose (see the unique index).
  "opportunity_deal_id" integer,

  -- The loop declines for reasons that expire ("they replied", "the ball is
  -- ours", "the system wrote to them four days ago"), so a refused trigger is
  -- re-offered rather than abandoned. Without a counter and a timestamp the
  -- re-offer has no interval and a nightly sweep pays for a draft every morning.
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_attempt_at" timestamp,

  "outcome" text,
  -- Where it stopped, and the loop's own sentence, stored verbatim so the log
  -- needs no translation. A refusal nobody wrote down is indistinguishable from
  -- a trigger that never fired.
  "refusal_stage" text,
  "refusal_reason" text,

  -- What the loop produced, when it produced something.
  "autonomy_hold_id" text,
  "autonomous_decision_id" text,
  "outbound_message_id" text,

  "fired_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "customer_lifecycle_triggers" ADD CONSTRAINT "chk_customer_lifecycle_triggers_kind"
  CHECK ("kind" IN ('renewal-due', 'churn-risk'));

--> statement-breakpoint
ALTER TABLE "customer_lifecycle_triggers" ADD CONSTRAINT "chk_customer_lifecycle_triggers_outcome"
  CHECK ("outcome" IS NULL OR "outcome" IN ('held', 'skipped'));

--> statement-breakpoint
-- Five stages, and the two at the ends are the ones a reader most needs.
-- `opportunity` is the trigger failing before the loop was ever reached (no
-- owner to write as, the deal could not be opened); `loop-error` is the loop
-- being unreachable, which is an outage rather than a judgement. Collapsing
-- either into the loop's own three would make "the renewal was declined" and
-- "the renewal was never considered" the same row.
ALTER TABLE "customer_lifecycle_triggers" ADD CONSTRAINT "chk_customer_lifecycle_triggers_stage"
  CHECK ("refusal_stage" IS NULL OR "refusal_stage" IN
    ('opportunity', 'eligibility', 'draft', 'confidence', 'loop-error'));

--> statement-breakpoint
-- The invariant the log rests on, in the database rather than only in the
-- service. A HELD trigger points at the message it produced and states no
-- refusal; a SKIPPED one states where it stopped and why, and points at nothing.
-- Without this a writer can file "held" with no hold -- a renewal the log claims
-- is being worked and that nothing is working -- or "skipped" with no reason,
-- which is the gap this table exists to close.
ALTER TABLE "customer_lifecycle_triggers" ADD CONSTRAINT "chk_customer_lifecycle_triggers_evidence"
  CHECK (
    ("outcome" IS NULL AND "refusal_stage" IS NULL AND "refusal_reason" IS NULL
       AND "autonomy_hold_id" IS NULL AND "outbound_message_id" IS NULL) OR
    ("outcome" = 'held' AND "refusal_stage" IS NULL AND "refusal_reason" IS NULL
       AND "autonomy_hold_id" IS NOT NULL AND "outbound_message_id" IS NOT NULL) OR
    ("outcome" = 'skipped' AND "refusal_stage" IS NOT NULL AND "refusal_reason" IS NOT NULL
       AND "autonomy_hold_id" IS NULL AND "outbound_message_id" IS NULL)
  );

--> statement-breakpoint
-- An outcome means the loop was asked, and being asked means an attempt. The
-- pair going out of step is how a re-offer interval computed from `attempts`
-- silently stops bounding anything.
ALTER TABLE "customer_lifecycle_triggers" ADD CONSTRAINT "chk_customer_lifecycle_triggers_attempts"
  CHECK (
    "attempts" >= 0 AND
    ("outcome" IS NULL OR ("attempts" > 0 AND "last_attempt_at" IS NOT NULL))
  );

--> statement-breakpoint
-- The bands both scores are drawn from. A stored 140 would have no band and
-- would render as nothing on every surface that colours by one.
ALTER TABLE "customer_lifecycle_triggers" ADD CONSTRAINT "chk_customer_lifecycle_triggers_scores"
  CHECK (
    "risk_score" BETWEEN 0 AND 100 AND
    ("health_score" IS NULL OR "health_score" BETWEEN 0 AND 100)
  );

--> statement-breakpoint
-- A conversation cannot become due after the renewal it is about, and cannot
-- become due before the term it belongs to began. Both are only reachable
-- through a bug in the trigger's date arithmetic, which is exactly the class of
-- bug that produces a plausible-looking wrong date nobody notices.
ALTER TABLE "customer_lifecycle_triggers" ADD CONSTRAINT "chk_customer_lifecycle_triggers_dates"
  CHECK ("due_on" <= "renewal_on" AND "due_on" >= "term_started_on");

--> statement-breakpoint
ALTER TABLE "customer_lifecycle_triggers" ADD CONSTRAINT "fk_customer_lifecycle_triggers_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_lifecycle_triggers" VALIDATE CONSTRAINT "fk_customer_lifecycle_triggers_org";

--> statement-breakpoint
-- The composite tenant key, so a trigger cannot cite another organisation's
-- contract. 0550 created `uniq_customer_lifecycles_org_id` for exactly this.
ALTER TABLE "customer_lifecycle_triggers" ADD CONSTRAINT "fk_customer_lifecycle_triggers_lifecycle"
  FOREIGN KEY ("organization_id", "customer_lifecycle_id")
  REFERENCES "customer_lifecycles"("organization_id", "customer_lifecycle_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_lifecycle_triggers" VALIDATE CONSTRAINT "fk_customer_lifecycle_triggers_lifecycle";

--> statement-breakpoint
/*
 * The party key needs a unique constraint on exactly
 * ("organization_id", "party_id"). 0520 promoted it and 0550/0552 re-assert it;
 * this is belt and braces, because a database built purely by running
 * migrations in order aborts with `42830: there is no unique constraint
 * matching given keys` if it is ever only an index. Idempotent, following 0552.
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
END $$;

--> statement-breakpoint
ALTER TABLE "customer_lifecycle_triggers" ADD CONSTRAINT "fk_customer_lifecycle_triggers_party"
  FOREIGN KEY ("organization_id", "party_id")
  REFERENCES "business_parties"("organization_id", "party_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_lifecycle_triggers" VALIDATE CONSTRAINT "fk_customer_lifecycle_triggers_party";

--> statement-breakpoint
/*
 * `uniq_deals_org_id` is a Drizzle declaration that 0214, 0265 and 0290 each had
 * to create for the same reason, and this is another: a database built purely by
 * running migrations in order has the index but not the constraint, and the
 * foreign key below aborts with `42830: there is no unique constraint matching
 * given keys` -- which fails the whole run, not just this statement.
 */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_deals_org_id') THEN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uniq_deals_org_id' AND relkind = 'i') THEN
      ALTER TABLE "deals" ADD CONSTRAINT "uniq_deals_org_id" UNIQUE USING INDEX "uniq_deals_org_id";
    ELSE
      ALTER TABLE "deals" ADD CONSTRAINT "uniq_deals_org_id" UNIQUE ("org_id", "id");
    END IF;
  END IF;
END $$;

--> statement-breakpoint
-- The opportunity, against `uniq_deals_org_id`. Nullable, so a claimed term with
-- no deal yet is permitted (MATCH SIMPLE ignores a partly-null key) while a
-- non-null id is guaranteed to name a deal of THIS organisation. CASCADE
-- follows 0550 and 0552: over a composite key SET NULL would null
-- `organization_id` too, which is NOT NULL. Deals are soft-deleted and nothing
-- in `src/` hard-deletes one, so the path that fires is an organisation being
-- torn down.
ALTER TABLE "customer_lifecycle_triggers" ADD CONSTRAINT "fk_customer_lifecycle_triggers_deal"
  FOREIGN KEY ("organization_id", "opportunity_deal_id")
  REFERENCES "deals"("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_lifecycle_triggers" VALIDATE CONSTRAINT "fk_customer_lifecycle_triggers_deal";

--> statement-breakpoint
-- One conversation per contract per term, and the reason a sweep is safe on a
-- cron. It is also the CLAIM: the service inserts here before it opens the
-- opportunity, so two sweeps racing on one contract cannot both create a deal --
-- the loser's insert is a no-op with nothing to orphan. The reverse order would
-- leave a duplicate renewal in the pipeline every time a person pressed the
-- button while the nightly sweep was running.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_customer_lifecycle_triggers_term"
  ON "customer_lifecycle_triggers" ("organization_id", "customer_lifecycle_id", "term_started_on");

--> statement-breakpoint
-- The log read: what fired, newest first. Tenant column leading because the RLS
-- predicate is not leakproof and the planner needs it in the index.
CREATE INDEX IF NOT EXISTS "idx_customer_lifecycle_triggers_fired"
  ON "customer_lifecycle_triggers" ("organization_id", "fired_at");

--> statement-breakpoint
-- Every trigger against one customer -- the account view's question, and the
-- party foreign key's own delete-time lookup. One index serves both.
CREATE INDEX IF NOT EXISTS "idx_customer_lifecycle_triggers_party"
  ON "customer_lifecycle_triggers" ("organization_id", "party_id");

--> statement-breakpoint
-- Without a policy this table is readable organisation-wide: grants arrive
-- through ALTER DEFAULT PRIVILEGES, so a missing policy is silent. It says which
-- of a tenant's customers are thought to be leaving and what was written to them
-- about it.
ALTER TABLE "customer_lifecycle_triggers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "customer_lifecycle_triggers";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_lifecycle_triggers"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "customer_lifecycle_triggers" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "customer_lifecycle_triggers" TO streamline_app;

--> statement-breakpoint
ANALYZE "customer_lifecycle_triggers";

--> statement-breakpoint
-- Ticket 09's keys. `GET /crm/lifecycle-triggers`,
-- `POST /crm/lifecycle-triggers/sweep` and
-- `POST /crm/lifecycle-triggers/:customerLifecycleId/consider` become reachable.
--
-- Two keys, and the split is not the usual view/manage. `run` is not a record
-- edit: a sweep opens opportunities in the pipeline, spends the tenant's AI
-- credits drafting, and starts hold windows that end in mail leaving the
-- building unless a human cancels them inside the window. Folding that into
-- `crm:lifecycle:manage` -- which a renewals administrator plainly needs, to
-- file signals and close terms -- would hand autonomous outbound to everybody
-- who maintains the book.
--
-- The slugs are `CRM_MODULE_OWNER|ADMIN|MEMBER`, which is what
-- `seedSystemRolesForOrg` actually mints -- NOT `CRM_ADMIN`, which is a
-- `ROLE_TEMPLATES` entry no organisation has. Seven CRM migrations made exactly
-- that mistake, granted eighteen permissions to nobody, and reported success:
-- `ON CONFLICT DO NOTHING` over an empty result set is a clean migration. See
-- 0226 and `backfill-slugs-exist.spec.ts`.
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('crm:lifecycle-triggers:view', 'crm:lifecycle-triggers', 'view',
   'Read the renewal and churn trigger log: which contracts opened a renewal conversation, why, and what the outbound loop answered',
   'crm'),
  ('crm:lifecycle-triggers:run', 'crm:lifecycle-triggers', 'run',
   'Run a renewal sweep: open renewal opportunities for contracts that are due or at risk, and offer them to the autonomous outbound loop',
   'crm')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
-- Owners and admins receive the module's whole namespace, which is what
-- `buildModuleAdminPermissionKeys` gives a newly seeded organisation.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (VALUES
  ('crm:lifecycle-triggers:view'),
  ('crm:lifecycle-triggers:run')
) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" IN ('CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN', 'ORG_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."permission_key")
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Members receive the read key only, mirroring `buildModuleMemberPermissionKeys`
-- exactly -- it filters the module's namespace to keys ending `:view` or
-- `:read`, so `:run` is not a member key in a freshly seeded organisation
-- either. Kept identical on purpose: a backfilled organisation and a new one
-- must resolve to the same capability, or behaviour depends on signup date.
--
-- No `OWNER` grant, and not because it was forgotten: `access.service.ts`
-- answers scope 'all' for `isOrgOwner` before any grant is consulted.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'crm:lifecycle-triggers:view', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" = 'CRM_MODULE_MEMBER'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'crm:lifecycle-triggers:view')
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Bump so cached permission resolutions are invalidated across every node at
-- once; a role that gained a key and a cache that has not heard about it is a
-- 403 nobody can reproduce.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true
  AND (r."slug" LIKE 'CRM_MODULE_%' OR r."slug" = 'ORG_ADMIN')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
