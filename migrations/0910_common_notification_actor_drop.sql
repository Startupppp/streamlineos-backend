-- 0910: Contract normalized notification preferences and broadcast receipts
-- to organization membership identity after the 0901 expand and 0909 validate
-- phases. Application readers and writers no longer use either legacy user_id.

SET lock_timeout = '5s';

--> statement-breakpoint
UPDATE "notification_preference_rules" rule
SET "membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = rule.org_id
  AND member.user_id = rule.user_id
  AND rule.membership_id IS NULL;

--> statement-breakpoint
UPDATE "broadcast_read_receipts" receipt
SET "membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = receipt.org_id
  AND member.user_id = receipt.user_id
  AND receipt.membership_id IS NULL;

--> statement-breakpoint
UPDATE "notification_consents" consent
SET "membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = consent.org_id
  AND member.user_id = consent.user_id
  AND consent.membership_id IS NULL;

--> statement-breakpoint
UPDATE "notification_digest_items" digest
SET "membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = digest.org_id
  AND member.user_id = digest.user_id
  AND digest.membership_id IS NULL;

--> statement-breakpoint
DO $$
DECLARE
  preference_gaps bigint;
  receipt_gaps bigint;
  consent_gaps bigint;
  digest_gaps bigint;
BEGIN
  SELECT count(*) INTO preference_gaps
  FROM "notification_preference_rules"
  WHERE "membership_id" IS NULL;

  SELECT count(*) INTO receipt_gaps
  FROM "broadcast_read_receipts"
  WHERE "membership_id" IS NULL;

  SELECT count(*) INTO consent_gaps
  FROM "notification_consents"
  WHERE "membership_id" IS NULL;

  SELECT count(*) INTO digest_gaps
  FROM "notification_digest_items"
  WHERE "membership_id" IS NULL;

  IF preference_gaps > 0 OR receipt_gaps > 0 OR consent_gaps > 0 OR digest_gaps > 0 THEN
    RAISE EXCEPTION
      '0910 blocked: membership backfill incomplete (preference_rules=%, broadcast_receipts=%, consents=%, digest_items=%)',
      preference_gaps,
      receipt_gaps,
      consent_gaps,
      digest_gaps;
  END IF;
END $$;

--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_notification_pref_rule";

--> statement-breakpoint
DROP INDEX IF EXISTS "idx_notification_pref_rule_lookup";

--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_notification_pref_rule"
  ON "notification_preference_rules"
    ("org_id", "membership_id", "scope_type", "scope_key", "channel");

--> statement-breakpoint
CREATE INDEX "idx_notification_pref_rule_lookup"
  ON "notification_preference_rules"
    ("org_id", "membership_id", "scope_type", "scope_key");

--> statement-breakpoint
ALTER TABLE "notification_preference_rules"
  ADD CONSTRAINT "chk_notification_pref_rules_membership_not_null"
  CHECK ("membership_id" IS NOT NULL) NOT VALID;

--> statement-breakpoint
ALTER TABLE "notification_preference_rules"
  VALIDATE CONSTRAINT "chk_notification_pref_rules_membership_not_null";

--> statement-breakpoint
ALTER TABLE "notification_preference_rules"
  ALTER COLUMN "membership_id" SET NOT NULL;

--> statement-breakpoint
ALTER TABLE "notification_preference_rules"
  DROP CONSTRAINT "chk_notification_pref_rules_membership_not_null";

--> statement-breakpoint
ALTER TABLE "notification_preference_rules"
  DROP COLUMN IF EXISTS "user_id";

--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_notification_consents_current";

--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_notification_consents_current"
  ON "notification_consents" ("org_id", "membership_id", "channel", "destination");

--> statement-breakpoint
ALTER TABLE "notification_consents"
  ADD CONSTRAINT "chk_notification_consents_membership_not_null"
  CHECK ("membership_id" IS NOT NULL) NOT VALID;

--> statement-breakpoint
ALTER TABLE "notification_consents"
  VALIDATE CONSTRAINT "chk_notification_consents_membership_not_null";

--> statement-breakpoint
ALTER TABLE "notification_consents"
  ALTER COLUMN "membership_id" SET NOT NULL;

--> statement-breakpoint
ALTER TABLE "notification_consents"
  DROP CONSTRAINT "chk_notification_consents_membership_not_null";

--> statement-breakpoint
ALTER TABLE "notification_consents"
  DROP COLUMN IF EXISTS "user_id";

--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_notification_digest_open";

--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_notification_digest_open"
  ON "notification_digest_items" ("org_id", "membership_id", "channel", "coalesce_key")
  WHERE "flushed_at" IS NULL;

--> statement-breakpoint
ALTER TABLE "notification_digest_items"
  ADD CONSTRAINT "chk_notification_digest_membership_not_null"
  CHECK ("membership_id" IS NOT NULL) NOT VALID;

--> statement-breakpoint
ALTER TABLE "notification_digest_items"
  VALIDATE CONSTRAINT "chk_notification_digest_membership_not_null";

--> statement-breakpoint
ALTER TABLE "notification_digest_items"
  ALTER COLUMN "membership_id" SET NOT NULL;

--> statement-breakpoint
ALTER TABLE "notification_digest_items"
  DROP CONSTRAINT "chk_notification_digest_membership_not_null";

--> statement-breakpoint
ALTER TABLE "notification_digest_items"
  DROP COLUMN IF EXISTS "user_id";

--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_broadcast_read_receipts_org_user_broadcast";

--> statement-breakpoint
DROP INDEX IF EXISTS "idx_broadcast_read_receipts_user";

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_broadcast_read_receipts_org_membership_broadcast"
  ON "broadcast_read_receipts" ("org_id", "broadcast_id", "membership_id");

--> statement-breakpoint
ALTER TABLE "broadcast_read_receipts"
  ADD CONSTRAINT "chk_broadcast_receipts_membership_not_null"
  CHECK ("membership_id" IS NOT NULL) NOT VALID;

--> statement-breakpoint
ALTER TABLE "broadcast_read_receipts"
  VALIDATE CONSTRAINT "chk_broadcast_receipts_membership_not_null";

--> statement-breakpoint
ALTER TABLE "broadcast_read_receipts"
  ALTER COLUMN "membership_id" SET NOT NULL;

--> statement-breakpoint
ALTER TABLE "broadcast_read_receipts"
  DROP CONSTRAINT "chk_broadcast_receipts_membership_not_null";

--> statement-breakpoint
ALTER TABLE "broadcast_read_receipts"
  DROP COLUMN IF EXISTS "user_id";
