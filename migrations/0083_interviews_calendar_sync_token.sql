-- Add calendarSyncToken to interviews for Google/Outlook sync
ALTER TABLE "interviews" ADD COLUMN IF NOT EXISTS "calendar_sync_token" text;
