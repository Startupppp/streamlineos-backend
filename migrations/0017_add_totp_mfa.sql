ALTER TABLE "users" ADD COLUMN "totp_secret" text;
ALTER TABLE "users" ADD COLUMN "totp_enabled" boolean NOT NULL DEFAULT false;
