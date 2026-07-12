-- Extend the automation trigger catalog with SignOS lifecycle events, so orgs can build
-- automation rules (notify, webhook, create_task, etc.) off envelope/recipient/bulk-send activity.
DO $$ BEGIN
  ALTER TYPE "automation_trigger" ADD VALUE IF NOT EXISTS 'sign.envelope.sent';
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TYPE "automation_trigger" ADD VALUE IF NOT EXISTS 'sign.envelope.completed';
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TYPE "automation_trigger" ADD VALUE IF NOT EXISTS 'sign.envelope.declined';
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TYPE "automation_trigger" ADD VALUE IF NOT EXISTS 'sign.envelope.voided';
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TYPE "automation_trigger" ADD VALUE IF NOT EXISTS 'sign.envelope.expired';
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TYPE "automation_trigger" ADD VALUE IF NOT EXISTS 'sign.recipient.completed';
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TYPE "automation_trigger" ADD VALUE IF NOT EXISTS 'sign.bulk_send.completed';
EXCEPTION WHEN duplicate_object THEN null; END $$;
