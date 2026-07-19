DELETE FROM "notification_queue" WHERE "channel" IN ('SLACK', 'TEAMS');
DELETE FROM "notification_deliveries" WHERE "channel" IN ('SLACK', 'TEAMS') OR "provider" IN ('SLACK', 'TEAMS');
DELETE FROM "notification_provider_accounts" WHERE "channel" IN ('SLACK', 'TEAMS') OR "provider" IN ('SLACK', 'TEAMS');
DELETE FROM "notification_templates" WHERE "channel" IN ('SLACK', 'TEAMS');
DELETE FROM "notification_suppression_rules" WHERE "channel" IN ('SLACK', 'TEAMS');

UPDATE "notification_events" SET
  "default_channels" = (SELECT coalesce(jsonb_agg(c), '[]'::jsonb) FROM jsonb_array_elements_text("default_channels") AS t(c) WHERE c NOT IN ('SLACK', 'TEAMS')),
  "allowed_channels" = (SELECT coalesce(jsonb_agg(c), '[]'::jsonb) FROM jsonb_array_elements_text("allowed_channels") AS t(c) WHERE c NOT IN ('SLACK', 'TEAMS'))
WHERE "default_channels"::text ~ '(SLACK|TEAMS)' OR "allowed_channels"::text ~ '(SLACK|TEAMS)';

UPDATE "notification_policy_defaults" SET
  "default_channels" = (SELECT coalesce(jsonb_agg(c), '[]'::jsonb) FROM jsonb_array_elements_text("default_channels") AS t(c) WHERE c NOT IN ('SLACK', 'TEAMS'))
WHERE "default_channels"::text ~ '(SLACK|TEAMS)';

UPDATE "notification_policy_defaults" p SET "event_overrides" = (
  SELECT coalesce(jsonb_object_agg(e.key, CASE WHEN e.value ? 'channels'
    THEN jsonb_set(e.value, '{channels}', (SELECT coalesce(jsonb_agg(c), '[]'::jsonb) FROM jsonb_array_elements_text(e.value -> 'channels') AS t(c) WHERE c NOT IN ('SLACK', 'TEAMS')))
    ELSE e.value END), '{}'::jsonb)
  FROM jsonb_each(p."event_overrides") e
) WHERE p."event_overrides"::text ~ '(SLACK|TEAMS)';

UPDATE "notification_policy_defaults" p SET "category_overrides" = (
  SELECT coalesce(jsonb_object_agg(e.key, CASE WHEN e.value ? 'channels'
    THEN jsonb_set(e.value, '{channels}', (SELECT coalesce(jsonb_agg(c), '[]'::jsonb) FROM jsonb_array_elements_text(e.value -> 'channels') AS t(c) WHERE c NOT IN ('SLACK', 'TEAMS')))
    ELSE e.value END), '{}'::jsonb)
  FROM jsonb_each(p."category_overrides") e
) WHERE p."category_overrides"::text ~ '(SLACK|TEAMS)';

UPDATE "notification_policy_defaults" p SET "module_overrides" = (
  SELECT coalesce(jsonb_object_agg(e.key, CASE WHEN e.value ? 'channels'
    THEN jsonb_set(e.value, '{channels}', (SELECT coalesce(jsonb_agg(c), '[]'::jsonb) FROM jsonb_array_elements_text(e.value -> 'channels') AS t(c) WHERE c NOT IN ('SLACK', 'TEAMS')))
    ELSE e.value END), '{}'::jsonb)
  FROM jsonb_each(p."module_overrides") e
) WHERE p."module_overrides"::text ~ '(SLACK|TEAMS)';

UPDATE "broadcasts" SET
  "channels" = (SELECT coalesce(jsonb_agg(c), '[]'::jsonb) FROM jsonb_array_elements_text("channels") AS t(c) WHERE c NOT IN ('SLACK', 'TEAMS'))
WHERE "channels"::text ~ '(SLACK|TEAMS)';

UPDATE "notification_preferences" SET "channel_categories" = "channel_categories" - 'SLACK' - 'TEAMS' WHERE "channel_categories" ?| array['SLACK', 'TEAMS'];
ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "slack_enabled";
ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "teams_enabled";

ALTER TYPE "notification_channel" RENAME TO "notification_channel_old";
CREATE TYPE "notification_channel" AS ENUM ('IN_APP', 'EMAIL', 'PUSH', 'SMS', 'WHATSAPP', 'WEBHOOK');
ALTER TABLE "notification_templates" ALTER COLUMN "channel" TYPE "notification_channel" USING "channel"::text::"notification_channel";
ALTER TABLE "notification_deliveries" ALTER COLUMN "channel" TYPE "notification_channel" USING "channel"::text::"notification_channel";
ALTER TABLE "notification_queue" ALTER COLUMN "channel" TYPE "notification_channel" USING "channel"::text::"notification_channel";
ALTER TABLE "notification_provider_accounts" ALTER COLUMN "channel" TYPE "notification_channel" USING "channel"::text::"notification_channel";
ALTER TABLE "notification_suppression_rules" ALTER COLUMN "channel" TYPE "notification_channel" USING "channel"::text::"notification_channel";
DROP TYPE "notification_channel_old";

ALTER TYPE "notification_provider" RENAME TO "notification_provider_old";
CREATE TYPE "notification_provider" AS ENUM ('SMTP', 'TWILIO', 'META_WHATSAPP', 'WEBHOOK', 'WEB_PUSH', 'INTERNAL', 'SANDBOX');
ALTER TABLE "notification_deliveries" ALTER COLUMN "provider" TYPE "notification_provider" USING "provider"::text::"notification_provider";
ALTER TABLE "notification_provider_accounts" ALTER COLUMN "provider" TYPE "notification_provider" USING "provider"::text::"notification_provider";
DROP TYPE "notification_provider_old";

DELETE FROM "marketplace_apps" WHERE "slug" = 'slack';
