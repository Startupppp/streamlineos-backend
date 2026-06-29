-- Add agenda, post-meeting notes, linked deal/lead, and reminder sent flag to calendar_events
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "agenda" text;
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "post_meeting_notes" text;
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "linked_deal_id" integer;
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "linked_lead_id" integer;
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "reminder_15min_sent" boolean DEFAULT false;
