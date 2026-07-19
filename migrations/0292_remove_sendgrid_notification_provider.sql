UPDATE "notification_deliveries" SET "provider" = 'SMTP' WHERE "provider" = 'SENDGRID';
UPDATE "notification_provider_accounts" SET "provider" = 'SMTP' WHERE "provider" = 'SENDGRID';

ALTER TYPE "notification_provider" RENAME TO "notification_provider_old";

CREATE TYPE "notification_provider" AS ENUM ('SMTP', 'TWILIO', 'META_WHATSAPP', 'SLACK', 'TEAMS', 'WEBHOOK', 'WEB_PUSH', 'INTERNAL', 'SANDBOX');

ALTER TABLE "notification_deliveries"
  ALTER COLUMN "provider" TYPE "notification_provider"
  USING "provider"::text::"notification_provider";

ALTER TABLE "notification_provider_accounts"
  ALTER COLUMN "provider" TYPE "notification_provider"
  USING "provider"::text::"notification_provider";

DROP TYPE "notification_provider_old";
