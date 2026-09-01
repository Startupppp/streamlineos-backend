-- 0865: EXPAND support and KB tables with membership_id columns.
--
-- Each column below is an authority-bearing users.id reference that appears in a WHERE
-- predicate gating access (assignee lookup, visibility gate, own-record ESS). Moving to
-- organization_members.id makes revocation revoke: SET NULL on membership deletion
-- (PG15+ column-list syntax) nulls the auth pointer so the predicate no longer matches.
-- Legacy user-id columns are NOT dropped here.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "assignee_membership_id" integer;

--> statement-breakpoint
UPDATE "support_tickets" t
SET "assignee_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = t.org_id
  AND om.user_id = t.assignee_id
  AND t.assignee_id IS NOT NULL
  AND t."assignee_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "support_tickets"
  ADD CONSTRAINT "fk_support_tickets_assignee_actor"
  FOREIGN KEY ("org_id", "assignee_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("assignee_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_tickets_org_assignee_actor"
  ON "support_tickets" ("org_id", "assignee_membership_id", "created_at");

--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "created_by_membership_id" integer;

--> statement-breakpoint
UPDATE "support_tickets" t
SET "created_by_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = t.org_id
  AND om.user_id = t.created_by
  AND t."created_by_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "support_tickets"
  ADD CONSTRAINT "fk_support_tickets_created_actor"
  FOREIGN KEY ("org_id", "created_by_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("created_by_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_tickets_org_created_actor"
  ON "support_tickets" ("org_id", "created_by_membership_id");

--> statement-breakpoint
ALTER TABLE "support_macros" ADD COLUMN IF NOT EXISTS "created_by_membership_id" integer;

--> statement-breakpoint
UPDATE "support_macros" m
SET "created_by_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = m.org_id
  AND om.user_id = m.created_by
  AND m.created_by IS NOT NULL
  AND m."created_by_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "support_macros"
  ADD CONSTRAINT "fk_support_macros_created_actor"
  FOREIGN KEY ("org_id", "created_by_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("created_by_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_macros_org_created_actor"
  ON "support_macros" ("org_id", "created_by_membership_id");

--> statement-breakpoint
ALTER TABLE "support_routing_rules" ADD COLUMN IF NOT EXISTS "assignee_membership_id" integer;

--> statement-breakpoint
UPDATE "support_routing_rules" r
SET "assignee_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = r.org_id
  AND om.user_id = r.assignee_id
  AND r.assignee_id IS NOT NULL
  AND r."assignee_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "support_routing_rules"
  ADD CONSTRAINT "fk_support_routing_rules_assignee_actor"
  FOREIGN KEY ("org_id", "assignee_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("assignee_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_routing_rules_org_assignee_actor"
  ON "support_routing_rules" ("org_id", "assignee_membership_id");

--> statement-breakpoint
ALTER TABLE "support_saved_views" ADD COLUMN IF NOT EXISTS "owner_membership_id" integer;

--> statement-breakpoint
UPDATE "support_saved_views" v
SET "owner_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = v.org_id
  AND om.user_id = v.owner_id
  AND v.owner_id IS NOT NULL
  AND v."owner_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "support_saved_views"
  ADD CONSTRAINT "fk_support_saved_views_owner_actor"
  FOREIGN KEY ("org_id", "owner_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_saved_views_org_owner_actor"
  ON "support_saved_views" ("org_id", "owner_membership_id");

--> statement-breakpoint
ALTER TABLE "support_ticket_watchers" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "support_ticket_watchers" w
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = w.org_id
  AND om.user_id = w.user_id
  AND w."user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "support_ticket_watchers"
  ADD CONSTRAINT "fk_support_ticket_watchers_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_ticket_watchers_org_user_actor"
  ON "support_ticket_watchers" ("org_id", "user_membership_id");

--> statement-breakpoint
ALTER TABLE "support_agent_skills" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "support_agent_skills" s
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = s.org_id
  AND om.user_id = s.user_id
  AND s."user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "support_agent_skills"
  ADD CONSTRAINT "fk_support_agent_skills_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_agent_skills_org_user_actor"
  ON "support_agent_skills" ("org_id", "user_membership_id");

--> statement-breakpoint
ALTER TABLE "support_agent_availability" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "support_agent_availability" a
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = a.org_id
  AND om.user_id = a.user_id
  AND a."user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "support_agent_availability"
  ADD CONSTRAINT "fk_support_agent_availability_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_agent_avail_org_user_actor"
  ON "support_agent_availability" ("org_id", "user_membership_id");

--> statement-breakpoint
ALTER TABLE "support_message_mentions" ADD COLUMN IF NOT EXISTS "mentioned_user_membership_id" integer;

--> statement-breakpoint
UPDATE "support_message_mentions" m
SET "mentioned_user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = m.org_id
  AND om.user_id = m.mentioned_user_id
  AND m."mentioned_user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "support_message_mentions"
  ADD CONSTRAINT "fk_support_message_mentions_mentioned_actor"
  FOREIGN KEY ("org_id", "mentioned_user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_message_mentions_org_mentioned_actor"
  ON "support_message_mentions" ("org_id", "mentioned_user_membership_id");

--> statement-breakpoint
ALTER TABLE "support_ticket_drafts" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "support_ticket_drafts" d
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = d.org_id
  AND om.user_id = d.user_id
  AND d."user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "support_ticket_drafts"
  ADD CONSTRAINT "fk_support_ticket_drafts_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_ticket_drafts_org_user_actor"
  ON "support_ticket_drafts" ("org_id", "user_membership_id");

--> statement-breakpoint
ALTER TABLE "kb_articles" ADD COLUMN IF NOT EXISTS "owner_membership_id" integer;

--> statement-breakpoint
UPDATE "kb_articles" a
SET "owner_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = a.org_id
  AND om.user_id = a.owner_id
  AND a.owner_id IS NOT NULL
  AND a."owner_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "kb_articles"
  ADD CONSTRAINT "fk_kb_articles_owner_actor"
  FOREIGN KEY ("org_id", "owner_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("owner_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_articles_org_owner_actor"
  ON "kb_articles" ("org_id", "owner_membership_id");
