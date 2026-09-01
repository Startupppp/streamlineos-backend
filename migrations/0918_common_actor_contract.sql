-- 0918: Contract Common authority relationships to organization_members.
-- user_id values remain as stable historical/delivery display projections only;
-- every tenant-scoped authority lookup is represented by membership_id.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "membership_id" integer;
ALTER TABLE "notification_read_watermarks" ADD COLUMN IF NOT EXISTS "membership_id" integer;
ALTER TABLE "notification_suppression_rules" ADD COLUMN IF NOT EXISTS "membership_id" integer;

--> statement-breakpoint
UPDATE "agent_tokens" row SET "issuer_membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.user_id AND row.issuer_membership_id IS NULL;

UPDATE "user_integration_connections" row SET "membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.user_id AND row.membership_id IS NULL;

UPDATE "notifications" row SET "membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.user_id AND row.membership_id IS NULL;

UPDATE "notification_read_watermarks" row SET "membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.user_id AND row.membership_id IS NULL;

UPDATE "notification_preferences" row SET "membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.user_id AND row.membership_id IS NULL;

UPDATE "notification_deliveries" row SET "membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.user_id AND row.membership_id IS NULL;

UPDATE "notification_suppression_rules" row SET "membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.user_id AND row.membership_id IS NULL;

UPDATE "onboarding_flow_sessions" row SET "membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.user_id AND row.membership_id IS NULL;

UPDATE "user_tour_progress" row SET "membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.user_id AND row.membership_id IS NULL;

UPDATE "push_subscriptions" row SET "membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.user_id AND row.membership_id IS NULL;

UPDATE "coupon_redemptions" row SET "membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.user_id AND row.membership_id IS NULL;

--> statement-breakpoint
DO $$
DECLARE unmappable_count bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM "agent_tokens" WHERE "issuer_membership_id" IS NULL) +
    (SELECT count(*) FROM "user_integration_connections" WHERE "membership_id" IS NULL) +
    (SELECT count(*) FROM "notifications" WHERE "user_id" IS NOT NULL AND "membership_id" IS NULL) +
    (SELECT count(*) FROM "notification_read_watermarks" WHERE "membership_id" IS NULL) +
    (SELECT count(*) FROM "notification_preferences" WHERE "membership_id" IS NULL) +
    (SELECT count(*) FROM "notification_deliveries" WHERE "membership_id" IS NULL) +
    (SELECT count(*) FROM "notification_suppression_rules" WHERE "user_id" IS NOT NULL AND "membership_id" IS NULL) +
    (SELECT count(*) FROM "onboarding_flow_sessions" WHERE "membership_id" IS NULL) +
    (SELECT count(*) FROM "user_tour_progress" WHERE "membership_id" IS NULL) +
    (SELECT count(*) FROM "push_subscriptions" WHERE "membership_id" IS NULL) +
    (SELECT count(*) FROM "coupon_redemptions" WHERE "user_id" IS NOT NULL AND "membership_id" IS NULL)
  INTO unmappable_count;
  IF unmappable_count > 0 THEN
    RAISE NOTICE '0918 unmappable Common actor rows=%; retained as nullable historical records and denied authority', unmappable_count;
  END IF;
END $$;

--> statement-breakpoint
-- Remove only users.id authority FKs. The columns are retained for immutable
-- display/delivery history, while membership composite FKs provide tenant safety.
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass
      AND t.relname IN ('agent_tokens', 'user_integration_connections', 'notifications',
        'notification_read_watermarks', 'notification_preferences', 'notification_deliveries',
        'notification_suppression_rules', 'onboarding_flow_sessions', 'user_tour_progress',
        'push_subscriptions', 'coupon_redemptions')
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',
      (SELECT t.relname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE c.conname = constraint_name LIMIT 1),
      constraint_name);
  END LOOP;
END $$;

--> statement-breakpoint
DROP INDEX IF EXISTS "idx_notifications_list_cursor";
DROP INDEX IF EXISTS "idx_notifications_unread_count";
DROP INDEX IF EXISTS "idx_notifications_user_archived";
DROP INDEX IF EXISTS "idx_notifications_org_user_active";
DROP INDEX IF EXISTS "uniq_notification_read_watermarks_org_user";
DROP INDEX IF EXISTS "uniq_notification_preferences_org_user";
DROP INDEX IF EXISTS "idx_notification_deliveries_user_channel";
DROP INDEX IF EXISTS "idx_notification_suppression_lookup";
DROP INDEX IF EXISTS "idx_onb_flow_sessions_org_user_type";
DROP INDEX IF EXISTS "uq_user_tour_progress_org_user_tour";
DROP INDEX IF EXISTS "idx_push_subs_user";

CREATE INDEX IF NOT EXISTS "idx_notifications_list_cursor" ON "notifications" ("org_id", "membership_id", "id" DESC) WHERE "deleted_at" IS NULL AND "archived_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_notifications_unread_count" ON "notifications" ("org_id", "membership_id", "id") WHERE "deleted_at" IS NULL AND "archived_at" IS NULL AND "is_read" = false;
CREATE INDEX IF NOT EXISTS "idx_notifications_org_membership_archived" ON "notifications" ("org_id", "membership_id", "archived_at");
CREATE INDEX IF NOT EXISTS "idx_notifications_org_membership_active" ON "notifications" ("org_id", "membership_id", "id") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notification_read_watermarks_org_membership" ON "notification_read_watermarks" ("org_id", "membership_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notification_preferences_org_membership" ON "notification_preferences" ("org_id", "membership_id");
CREATE INDEX IF NOT EXISTS "idx_notification_deliveries_membership_channel" ON "notification_deliveries" ("org_id", "membership_id", "channel", "created_at");
CREATE INDEX IF NOT EXISTS "idx_notification_suppression_lookup" ON "notification_suppression_rules" ("org_id", "membership_id", "scope_type", "scope_key");
CREATE INDEX IF NOT EXISTS "idx_onb_flow_sessions_org_membership_type" ON "onboarding_flow_sessions" ("org_id", "membership_id", "type");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_user_tour_progress_org_membership_tour" ON "user_tour_progress" ("org_id", "membership_id", "tour_key");

--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "fk_notifications_recipient_membership" FOREIGN KEY ("org_id", "membership_id") REFERENCES "organization_members"("org_id", "id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "notification_read_watermarks" ADD CONSTRAINT "fk_notification_read_watermarks_membership" FOREIGN KEY ("org_id", "membership_id") REFERENCES "organization_members"("org_id", "id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "notification_suppression_rules" ADD CONSTRAINT "fk_notification_suppression_rules_membership" FOREIGN KEY ("org_id", "membership_id") REFERENCES "organization_members"("org_id", "id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "notifications" VALIDATE CONSTRAINT "fk_notifications_recipient_membership";
ALTER TABLE "notification_read_watermarks" VALIDATE CONSTRAINT "fk_notification_read_watermarks_membership";
ALTER TABLE "notification_suppression_rules" VALIDATE CONSTRAINT "fk_notification_suppression_rules_membership";
