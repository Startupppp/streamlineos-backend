-- Add reactions JSONB column to chat_messages
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "reactions" JSONB NOT NULL DEFAULT '{}';

-- Add is_pinned column to chat_channels
ALTER TABLE "chat_channels" ADD COLUMN IF NOT EXISTS "is_pinned" BOOLEAN NOT NULL DEFAULT false;

-- Add linked_deal_id to chat_channels for auto-created deal channels
ALTER TABLE "chat_channels" ADD COLUMN IF NOT EXISTS "linked_deal_id" INTEGER REFERENCES "deals"("id") ON DELETE SET NULL;
